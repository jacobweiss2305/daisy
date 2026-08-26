import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { run, type AgentDeps, type AgentEvent } from './agent.ts';
import { listAll, type Endpoint, type LlmConfig, type ModelRef } from './llm.ts';
import { Sessions, type Session, type Store } from './sessions.ts';
import { DEFAULT_LIMITS, expandMentions, type Limits } from './tools.ts';
import { OtelClient, TurnTrace, parseHeaders, resolveOtel, resourceFor, spanId } from './otel.ts';
import { judgeTurn, resolveJudge, type JudgeSettings } from './judge.ts';
import { VerdictQueue } from './verdict-queue.ts';
import type { OtelConfig } from './otel.ts';

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
  | { type: 'config'; endpoints: Endpoint[]; systemPrompt: string; active: string }
  | {
      type: 'chats';
      items: { id: string; title: string; updatedAt: number; turns: number }[];
      active: string;
      running: string[];
    }
  | {
      type: 'telemetry';
      enabled: boolean;
      active: string;
      endpoint: string;
      headers: string;
      serviceName: string;
      resourceAttributes: string;
      pending: number;
    }
  | { type: 'done' };

type FromView =
  | { type: 'send'; text: string }
  | { type: 'model'; ref: ModelRef }
  | { type: 'session'; id: string }
  | { type: 'new' }
  | { type: 'refresh' }
  | {
      type: 'saveConfig';
      endpoints: Endpoint[];
      systemPrompt: string;
      active: string;
      telemetry?:
        | { enabled: boolean; endpoint: string; headers: string; serviceName: string; resourceAttributes: string }
        | undefined;
    }
  | { type: 'deleteChat'; id: string }
  | { type: 'ready' }
  | { type: 'cancel' };

const DEFAULT_SYSTEM = "You are Daisy, a coding agent inside VS Code, working in the user's open folder.\nUse the tools to inspect and change files rather than guessing or asking for pasted code.\nPaths are relative to the workspace root.";

const FILE_BLOCK = /<file path="[^"]*">[\s\S]*?<\/file>\n\n/g;

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewId = 'daisy.chat';

  private readonly ext: vscode.Uri;
  private readonly sessions: Sessions;
  private readonly otel: OtelClient;
  private readonly verdictQueue: VerdictQueue;
  private session: Session;
  /** One run per chat, so chats work in parallel. */
  private readonly runs = new Map<string, AbortController>();

  constructor(ext: vscode.Uri, store: Store, otel: OtelClient, verdictQueue: VerdictQueue) {
    this.ext = ext;
    this.sessions = new Sessions(store, settings().sessionsKept);
    this.otel = otel;
    this.verdictQueue = verdictQueue;
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
        this.sendConfig(webview);
        this.sendTelemetry(webview);
        void this.sendModels(webview);
        void this.sendFiles(webview);
        break;
      case 'send':
        if (!this.runs.has(this.session.id)) void this.turn(message.text, webview);
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
        this.sendTelemetry(webview);
        break;
      case 'saveConfig': {
        const clean = message.endpoints.filter((e) => e.name.trim() && e.baseUrl.trim());
        const config = vscode.workspace.getConfiguration('daisy');
        const telemetry = message.telemetry ? vscode.workspace.getConfiguration('daisy.telemetry') : undefined;
        void config.update('systemPrompt', message.systemPrompt, vscode.ConfigurationTarget.Global);
        void config.update('endpoint', message.active, vscode.ConfigurationTarget.Global);
        if (message.telemetry && telemetry) {
          void telemetry.update('enabled', message.telemetry.enabled, vscode.ConfigurationTarget.Global);
          void telemetry.update('endpoint', message.telemetry.endpoint.trim(), vscode.ConfigurationTarget.Global);
          void telemetry.update('headers', parseHeaders(message.telemetry.headers), vscode.ConfigurationTarget.Global);
          void telemetry.update(
            'serviceName',
            message.telemetry.serviceName.trim() || 'daisy',
            vscode.ConfigurationTarget.Global,
          );
          void telemetry.update(
            'resourceAttributes',
            parseHeaders(message.telemetry.resourceAttributes),
            vscode.ConfigurationTarget.Global,
          );
        }
        void config
          .update('endpoints', clean, vscode.ConfigurationTarget.Global)
          .then(() => {
            this.otel.updateConfig(otelConfig());
            this.sendConfig(webview);
            this.sendTelemetry(webview);
            return this.sendModels(webview);
          });
        break;
      }
      case 'deleteChat': {
        this.sessions.remove(message.id);
        this.session = this.sessions.active();
        this.sendSessions(webview);
        this.sendHistory(webview);
        break;
      }
      case 'cancel':
        this.runs.get(this.session.id)?.abort();
        break;
    }
  }

  private async turn(text: string, webview: vscode.Webview): Promise<void> {
    // Bind to the chat this turn belongs to. The user may switch away mid-run,
    // and the view drops events that are not for what it is showing.
    const chat = this.session;
    const post = (m: ToView): void =>
      void webview.postMessage({ ...m, chat: chat.id } satisfies ToView & { chat: string });
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!root) {
      post({ type: 'status', text: 'Open a folder to give Daisy a workspace.' });
      post({ type: 'done' });
      return;
    }

    const { cfg, system, limits, warmupMs } = settings();
    const controller = new AbortController();
    this.runs.set(chat.id, controller);

    const userContent = await expandMentions(text, { root, limits });
    chat.messages.push({ role: 'user', content: userContent });
    const turnStart = chat.messages.length;
    this.sessions.save(chat);
    this.sendSessions(webview);

    // One chat turn becomes one OTel trace, recorded as it happens and
    // exported when the turn ends. Off unless opted in.
    const telemetry = otelConfig();
    this.otel.updateConfig(telemetry);
    const turnNumber = chat.messages.filter((m) => m.role === 'user').length;
    const trace = telemetry.enabled
      ? new TurnTrace(`${chat.id}:${turnNumber}`, userContent, telemetry.maxAttrBytes, chat.id)
      : undefined;

    try {
      const deps: AgentDeps = {
        cfg,
        root,
        system,
        limits,
        warmupMs,
        signal: controller.signal,
        onWait: (seconds: number) =>
          post({ type: 'status', text: `Waiting for ${cfg.baseUrl} to start, ${seconds}s.` }),
        onObserve: (e) => {
          if (!trace) return;
          if (e.kind === 'llm') trace.llm(spanId(), e.observation);
          else trace.tool(spanId(), e.observation);
        },
      };
      for await (const event of run(chat.messages, deps)) post(project(event));
    } catch (e) {
      const reason = controller.signal.aborted ? 'Cancelled.' : (e as unknown as Error).message;
      post({ type: 'status', text: reason });
    } finally {
      this.runs.delete(chat.id);
      this.sessions.save(chat);
      this.sendSessions(webview);
      if (trace) this.otel.submit(trace.body(resourceFor(telemetry, root)));

      // The verdict is scored against the turn's trace, so there must be one:
      // telemetry has to be on. The judge runs on its own; by the time it runs
      // the turn is over, and nothing here can fail the chat.
      if (trace && !controller.signal.aborted) {
        const judge = judgeConfig();
        if (judge.enabled) {
          const record = {
            chatId: chat.id,
            turnNumber,
            userText: text,
            messages: chat.messages.slice(turnStart),
            traceId: trace.traceId,
            model: cfg.model,
          };
          void judgeTurn(record, { cfg, root, limits, settings: judge, queue: this.verdictQueue })
            .then((v) => {
              if (!v) return;
              const bits = [v.score != null ? `score ${v.score}` : '', v.summary].filter(Boolean);
              if (!bits.length && !v.parsed) bits.push('unparseable verdict filed as judge.raw');
              try {
                post({ type: 'status', text: `Judge: ${bits.join(', ') || 'no score in verdict'}` });
              } catch {
                // the view is gone; the verdict is still in the store
              }
            })
            .catch(() => {});
        }
      }

      void this.otel.flush().then(() => this.sendTelemetry(webview));
      post({ type: 'done' });
    }
  }

  private sendSessions(webview: vscode.Webview): void {
    const items = this.sessions
      .list()
      .map(({ id, title, updatedAt, messages }) => ({
        id,
        title,
        updatedAt,
        turns: messages.filter((m) => m.role === 'user').length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    void webview.postMessage({
      type: 'chats',
      items,
      active: this.session.id,
      running: [...this.runs.keys()],
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

  private sendConfig(webview: vscode.Webview): void {
    const { endpoints, system, active } = settings();
    void webview.postMessage({
      type: 'config',
      endpoints,
      systemPrompt: system,
      active: active.endpoint,
    } satisfies ToView);
  }

  /** The saved trace settings, plus the effective endpoint after env fallbacks, and what is queued. */
  private sendTelemetry(webview: vscode.Webview): void {
    const c = vscode.workspace.getConfiguration('daisy.telemetry');
    const pairs = (obj: Record<string, string>): string =>
      Object.entries(obj)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
    const resolved = otelConfig();
    void webview.postMessage({
      type: 'telemetry',
      enabled: c.get('enabled', false),
      active: resolved.enabled ? resolved.endpoint : '',
      endpoint: c.get('endpoint', ''),
      headers: pairs(c.get<Record<string, string>>('headers', {})),
      serviceName: c.get('serviceName', 'daisy'),
      resourceAttributes: pairs(c.get<Record<string, string>>('resourceAttributes', {})),
      pending: this.otel.pending,
    } satisfies ToView);
  }

  private async sendFiles(webview: vscode.Webview): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.venv,__pycache__}/**',
      settings().fileSearchLimit,
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

    // One endpoint serves one model, so the endpoint choice decides the model.
    const served = items.filter((m) => m.endpoint === active.endpoint);
    const live =
      served.find((m) => m.model === active.model) ?? served[0] ?? items[0] ?? active;

    if (live.model !== active.model || live.endpoint !== active.endpoint) {
      const config = vscode.workspace.getConfiguration('daisy');
      void config.update('endpoint', live.endpoint, vscode.ConfigurationTarget.Global);
      void config.update('model', live.model, vscode.ConfigurationTarget.Global);
    }

    void webview.postMessage({ type: 'models', items, selected: live } satisfies ToView);
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
<header id="chrome">
  <button id="title" class="title" type="button" title="All chats">
    <span id="titleText">New chat</span>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>
  </button>
  <button id="new" class="icon" type="button" title="New chat" aria-label="New chat">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>
  </button>
  <button id="gear" class="icon" type="button" title="Endpoints" aria-label="Endpoints">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  </button>
</header>

<div id="log"></div>
<div id="settings" hidden></div>
<div id="chats" hidden></div>

<form id="composer">
  <div id="mentions" hidden></div>
  <div id="queued"></div>
  <div class="field">
    <textarea id="prompt" rows="1" placeholder="Ask anything"></textarea>
    <button id="stop" class="stop" type="button" title="Stop" aria-label="Stop" hidden>
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1.4"/></svg>
    </button>
    <button id="submit" class="send" type="submit" title="Send" aria-label="Send">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2"/></svg>
    </button>
  </div>
</form>

<script nonce="${nonce}" src="${uri('markdown.js')}"></script>
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

/** Telemetry as the user has it set, re-read every turn so toggling it needs no reload. */
function otelConfig(): OtelConfig {
  const c = vscode.workspace.getConfiguration('daisy.telemetry');
  return resolveOtel({
    enabled: c.get('enabled', false),
    endpoint: c.get('endpoint', ''),
    headers: c.get('headers', {}),
    serviceName: c.get('serviceName', 'daisy'),
    resourceAttributes: c.get('resourceAttributes', {}),
    maxAttrBytes: c.get('maxAttrBytes', 32768),
  });
}

/** Judge settings, re-read per turn so toggling them needs no reload. */
function judgeConfig(): JudgeSettings {
  const c = vscode.workspace.getConfiguration('daisy.judge');
  return resolveJudge({
    enabled: c.get('enabled', false),
    endpoint: c.get('endpoint', ''),
    headers: c.get('headers', {}),
    systemPrompt: c.get('systemPrompt', ''),
    maxLoops: c.get('maxLoops', 12),
    maxTranscriptBytes: c.get('maxTranscriptBytes', 128 * 1024),
    source: c.get('source', 'daisy-judge'),
    delayMs: c.get('delayMs', 5000),
  });
}

function settings(): {
  endpoints: Endpoint[];
  active: ModelRef;
  cfg: LlmConfig;
  system: string;
  limits: Limits;
  sessionsKept: number;
  fileSearchLimit: number;
  warmupMs: number;
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
    system: c.get<string>('systemPrompt', '').trim() || DEFAULT_SYSTEM,
    limits: {
      fileBytes: c.get<number>('maxFileBytes', DEFAULT_LIMITS.fileBytes),
      commandTimeoutMs: c.get<number>('commandTimeout', 120) * 1000,
      outputBytes: c.get<number>('maxOutputBytes', DEFAULT_LIMITS.outputBytes),
    },
    sessionsKept: c.get<number>('sessionsKept', 30),
    fileSearchLimit: c.get<number>('fileSearchLimit', 3000),
    warmupMs: c.get<number>('warmupTimeout', 300) * 1000,
  };
}
