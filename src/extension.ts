import * as vscode from 'vscode';
import { ChatView } from './chat.ts';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('daisy.editSystemPrompt', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'daisy.systemPrompt'),
    ),
    vscode.window.registerWebviewViewProvider(
      ChatView.viewId,
      new ChatView(context.extensionUri, context.workspaceState),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}
