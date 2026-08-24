import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { run, type AgentEvent } from './agent.ts';
import type { LlmConfig, Message, ToolCall } from './llm.ts';

type ToView =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; args: string }
  | { type: 'result'; id: string; output: string; failed: boolean }
  | { type: 'approve'; id: string; name: string; args: string }
  | { type: 'status'; text: string }
  | { type: 'done' };

type FromView =
  | { type: 'send'; text: string }
  | { type: 'approval'; id: string; ok: boolean }
  | { type: 'cancel' };

const SYSTEM = `You are a coding agent inside VS Code, working in the user's open folder.
Use the tools to inspect and change files rather than guessing or asking the user to paste code.
Paths are relative to the workspace root. Keep replies short.`;

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewId = 'localAgent.chat';

  private readonly messages: Message[] = [{ role: 'system', content: SYSTEM }];
  private readonly approvals = new Map<string, (ok: boolean) => void>();
  private active: AbortController | undefined;

  constructor(private readonly ext: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [this.ext] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromView) => this.receive(m, view.webview));
  }

  private receive(message: FromView, webview: vscode.Webview): void {
    switch (message.type) {
      case 'send':
        if (!this.active) void this.turn(message.text, webview);
        break;
      case 'approval':
        this.approvals.get(message.id)?.(message.ok);
        this.approvals.delete(message.id);
        break;
      case 'cancel':
        this.active?.abort();
        this.denyPending();
        break;
    }
  }

  private async turn(text: string, webview: vscode.Webview): Promise<void> {
    const post = (m: ToView): void => void webview.postMessage(m);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!root) {
      post({ type: 'status', text: 'Open a folder to give the agent a workspace.' });
      post({ type: 'done' });
      return;
    }

    const { maxSteps, ...cfg } = settings();
    const controller = new AbortController();
    this.active = controller;
    this.messages.push({ role: 'user', content: text });

    try {
      const deps = {
        cfg,
        root,
        maxSteps,
        signal: controller.signal,
        approve: (call: ToolCall) => this.ask(call, webview),
      };
      for await (const event of run(this.messages, deps)) post(project(event));
    } catch (e) {
      const reason = controller.signal.aborted ? 'Cancelled.' : (e as Error).message;
      post({ type: 'status', text: reason });
    } finally {
      this.active = undefined;
      this.denyPending();
      post({ type: 'done' });
    }
  }

  private ask(call: ToolCall, webview: vscode.Webview): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvals.set(call.id, resolve);
      void webview.postMessage({
        type: 'approve',
        id: call.id,
        name: call.name,
        args: call.args,
      } satisfies ToView);
    });
  }

  private denyPending(): void {
    for (const resolve of this.approvals.values()) resolve(false);
    this.approvals.clear();
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
<div id="log"></div>
<form id="composer">
  <textarea id="prompt" rows="3" placeholder="Ask about this workspace"></textarea>
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
    case 'tool':
      return { type: 'tool', id: event.call.id, name: event.call.name, args: event.call.args };
    case 'result':
      return { type: 'result', id: event.id, output: event.output, failed: event.failed };
    case 'limit':
      return { type: 'status', text: 'Stopped at the step limit.' };
  }
}

function settings(): LlmConfig & { maxSteps: number } {
  const c = vscode.workspace.getConfiguration('localAgent');
  return {
    baseUrl: c.get<string>('baseUrl', 'http://localhost:11434/v1'),
    model: c.get<string>('model', ''),
    apiKey: c.get<string>('apiKey', ''),
    maxSteps: c.get<number>('maxSteps', 12),
  };
}
