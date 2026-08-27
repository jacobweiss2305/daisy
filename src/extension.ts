import * as vscode from 'vscode';
import { ChatView } from './chat.ts';
import { OtelClient, resolveOtel } from './otel.ts';
import { resolveJudge } from './judge.ts';
import { VerdictQueue } from './verdict-queue.ts';

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('daisy.telemetry');
  const client = new OtelClient({
    config: resolveOtel({
      enabled: config.get('enabled', false),
      endpoint: config.get('endpoint', ''),
      headers: config.get('headers', {}),
      serviceName: config.get('serviceName', 'daisy'),
      resourceAttributes: config.get('resourceAttributes', {}),
      maxAttrBytes: config.get('maxAttrBytes', 32768),
    }),
    // Re-check on every send so the setting takes effect live.
    shouldSend: () => vscode.workspace.getConfiguration('daisy.telemetry').get('enabled', false),
  });

  // Verdicts the judge filed but the store has not taken yet survive a
  // reload in the workspace state and are sent again from here.
  const queue = new VerdictQueue(context.workspaceState);
  const judgeDeps = () => {
    const c = vscode.workspace.getConfiguration('daisy.judge');
    return resolveJudge({
      enabled: c.get('enabled', false),
      endpoint: c.get('endpoint', ''),
      headers: c.get('headers', {}),
      systemPrompt: c.get('systemPrompt', ''),
      maxLoops: c.get('maxLoops', 0),
      maxTranscriptBytes: c.get('maxTranscriptBytes', 128 * 1024),
      source: c.get('source', 'daisy-judge'),
      delayMs: c.get('delayMs', 5000),
    });
  };
  // A flush on an empty queue is a no-op, so the guard only needs the
  // endpoint: nothing may be sent to a store the user has not turned on.
  const flushPending = () => {
    const s = judgeDeps();
    if (!s.enabled) return;
    void queue.flush({ endpoint: s.endpoint, headers: s.headers });
  };
  flushPending();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('daisy.judge')) flushPending();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('daisy.editSystemPrompt', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'daisy.systemPrompt'),
    ),
    vscode.window.registerWebviewViewProvider(
      ChatView.viewId,
      new ChatView(context.extensionUri, context.workspaceState, client, queue),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    new vscode.Disposable(() => {
      void client.shutdown();
    }),
  );
}
