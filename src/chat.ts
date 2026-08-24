import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { run, type AgentEvent } from './agent.ts';
import { listAll, type Endpoint, type LlmConfig, type ModelRef } from './llm.ts';
import { Sessions, type Session, type Store } from './sessions.ts';
import { expandMentions } from './tools.ts';

type ToView =
  | { type: 'text'; text: string }
  | { type: 'think'; text: string }
  | { type: 'tool'; id: string; name: string; args: string }
  | { type: 'result'; id: string; output: string; failed: boolean }
  | { type: 'status'; text: string }
  | { type: 'models'; items: ModelRef[]; selected: ModelRef }
  | { type: 'sessions'; items: { id: string; title: string }[]; active: string }
  | { type: 'history'; items: { role: 'user' | 'assistant'; text: string }[] }
  | { type: 'files'; items: string[] }
  | { type: 'done' };

type FromView =
  | { type: 'send'; text: string }
  | { type: 'model'; ref: ModelRef }
  | { type: 'session'; id: string }
  | { type: 'new' }
  | { type: 'refresh' }
  | { type: 'ready' }
  | { type: 'cancel' };

const SYSTEM = [
  "You are Daisy, a coding agent inside VS Code, working in the user's open folder.",
  'Use the tools to inspect and change files rather than guessing or asking for pasted code.',
  'Paths are relative to the workspace root. Keep replies short.',
].join('\n');

const FILE_BLOCK = /<file path="[^"]*">[\s\S]*?<\/file>\n\n/g;

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewId = 'daisy.chat';

  private readonly ext: vscode.Uri;
  private readonly sessions: Sessions;
  private session: Session;
  private active: AbortController | undefined;

  constructor(ext: vscode.Uri, store: Store) {
    this.ext = ext;
    this.sessions = new Sessions(store, SYSTEM);
    this.session = this.sessions.active();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [this.ext] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromView) => this.receive(m, view.webview));
  }

  private receive(message: FromView, webview: vscode.Webview): void {
    switch (message.type) {
      case 'ready':
        this.sendSessions(webview);
        this.sendHistory(webview);
        void this.sendModels(webview);
        void this.sendFiles(webview);
        break;
      case 'send':
        if (!this.active) void this.turn(message.text, webview);
        break;
      case 'session':
        this.session = this.sessions.select(message.id);
        this.sendSessions(webview);
        this.sendHistory(webview);
        break;
      case 'new':
        this.session = this.sessions.create();
        this.sendSessions(webview);
        this.sendHistory(webview);
        break;
      case 'model': {
        const config = vscode.workspace.getConfiguration('daisy');
        void config.update('endpoint', message.ref.endpoint, vscode.ConfigurationTarget.Global);
        void config.update('model', message.ref.model, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'refresh':
        void this.sendModels(webview);
        break;
      case 'cancel':
        this.active?.abort();
        break;
    }
  }

  private async turn(text: string, webview: vscode.Webview): Promise<void> {
    const post = (m: ToView): void => void webview.postMessage(m);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!root) {
      post({ type: 'status', text: 'Open a folder to give Daisy a workspace.' });
      post({ type: 'done' });
      return;
    }

    const { cfg } = settings();
    const controller = new AbortController();
    this.active = controller;

    this.session.messages.push({ role: 'user', content: await expandMentions(text, root) });
    this.sessions.save(this.session);
    this.sendSessions(webview);

    try {
      const deps = {
        cfg,
        root,
        signal: controller.signal,
        onWait: (seconds: number) =>
          post({ type: 'status', text: `Waiting for ${cfg.baseUrl} to start, ${seconds}s.` }),
      };
      for await (const event of run(this.session.messages, deps)) post(project(event));
    } catch (e) {
      const reason = controller.signal.aborted ? 'Cancelled.' : (e as Error).message;
      post({ type: 'status', text: reason });
    } finally {
      this.active = undefined;
      this.sessions.save(this.session);
      post({ type: 'done' });
    }
  }

  private sendSessions(webview: vscode.Webview): void {
    void webview.postMessage({
      type: 'sessions',
      items: this.sessions.list().map(({ id, title }) => ({ id, title })),
      active: this.session.id,
    } satisfies ToView);
  }

  private sendHistory(webview: vscode.Webview): void {
    const items = this.session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.content.trim())
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        text: m.content.replace(FILE_BLOCK, ''),
      }));

    void webview.postMessage({ type: 'history', items } satisfies ToView);
  }

  private async sendFiles(webview: vscode.Webview): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.venv,__pycache__}/**',
      3000,
    );
    const items = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
    void webview.postMessage({ type: 'files', items } satisfies ToView);
  }

  private async sendModels(webview: vscode.Webview): Promise<void> {
    const { endpoints, active } = settings();
    const items = await listAll(endpoints);

    if (!items.length) {
      void webview.postMessage({
        type: 'status',
        text: `No models from ${endpoints.map((e) => e.name).join(', ') || 'any endpoint'}.`,
      } satisfies ToView);
    }

    void webview.postMessage({ type: 'models', items, selected: active } satisfies ToView);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ext, 'media', file));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('main.css')}">
</head>
<body>
<div id="top">
  <div class="row">
    <select id="session" title="Chat"></select>
    <button id="new" type="button" title="Start a new chat">New</button>
  </div>
  <div class="row">
    <select id="model" title="Model"></select>
    <button id="refresh" type="button" title="Reload model list">Reload</button>
  </div>
</div>
<div id="log"></div>
<form id="composer">
  <div id="mentions" hidden></div>
  <textarea id="prompt" rows="3" placeholder="Ask about this workspace, @ to attach a file"></textarea>
  <button id="submit" type="submit">Send</button>
</form>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}

function project(event: AgentEvent): ToView {
  switch (event.kind) {
    case 'text':
      return { type: 'text', text: event.text };
    case 'think':
      return { type: 'think', text: event.text };
    case 'tool':
      return { type: 'tool', id: event.call.id, name: event.call.name, args: event.call.args };
    case 'result':
      return { type: 'result', id: event.id, output: event.output, failed: event.failed };
  }
}

const FALLBACK: Endpoint = { name: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' };

function settings(): {
  endpoints: Endpoint[];
  active: ModelRef;
  cfg: LlmConfig;
} {
  const c = vscode.workspace.getConfiguration('daisy');
  const endpoints = c.get<Endpoint[]>('endpoints', []);
  const usable = endpoints.length ? endpoints : [FALLBACK];

  const wanted = c.get<string>('endpoint', '');
  const chosen = usable.find((e) => e.name === wanted) ?? usable[0] ?? FALLBACK;
  const model = c.get<string>('model', '');

  return {
    endpoints: usable,
    active: { endpoint: chosen.name, model },
    cfg: { baseUrl: chosen.baseUrl, model, apiKey: chosen.apiKey ?? '' },
  };
}
