import * as vscode from 'vscode';
import { S3AIProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new S3AIProvider(context);

	context.subscriptions.push(
		provider,
		vscode.lm.registerLanguageModelChatProvider('s3ai', provider),
		vscode.commands.registerCommand('s3ai.manage', () => provider.manage()),
		vscode.commands.registerCommand('s3ai.setApiKey', () => provider.setApiKey()),
		vscode.commands.registerCommand('s3ai.clearApiKey', () => provider.clearApiKey()),
		vscode.commands.registerCommand('s3ai.refreshModels', () => provider.refreshModels()),
		vscode.commands.registerCommand('s3ai.openDocs', () =>
			vscode.env.openExternal(vscode.Uri.parse('https://docs.furry.vg/')),
		),
	);
}

export function deactivate(): void {
	// 资源通过 context.subscriptions 统一释放
}
