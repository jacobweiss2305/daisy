import * as vscode from 'vscode';
import { ChatView } from './chat.ts';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatView.viewId,
      new ChatView(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}
