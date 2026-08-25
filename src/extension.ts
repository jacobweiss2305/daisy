import * as vscode from 'vscode';
import { ChatView } from './chat.ts';
import { OtelClient, resolveOtel } from './otel.ts';

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

  context.subscriptions.push(
    vscode.commands.registerCommand('daisy.editSystemPrompt', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'daisy.systemPrompt'),
    ),
    vscode.window.registerWebviewViewProvider(
      ChatView.viewId,
      new ChatView(context.extensionUri, context.workspaceState, client),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    new vscode.Disposable(() => {
      void client.shutdown();
    }),
  );
}
