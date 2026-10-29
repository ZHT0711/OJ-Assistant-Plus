import * as vscode from 'vscode';
import { DebuggerTimer } from './debugger';
import { OJ, OJAssistConfig } from './model';
import { ProblemInfoViewProvider } from './window';
import { registerCommands } from './commands';
import { parseSourceFile } from './utils';
import { accounts } from './account/session';
import { isPracticeUri } from './practice/controller';
import { backends } from './backend';
import { submissions } from './account/controller';
export { accounts } from './account/session';
export { submissions } from './account/controller';

export * from './backend';

export function activate(context: vscode.ExtensionContext) {
	accounts.initialize(context);
	let provider: ProblemInfoViewProvider;
	context.subscriptions.push(accounts.onDidChange(session => {
		if (session !== accounts.current) { return; }
		provider?.invalidate();
		const editor = vscode.window.activeTextEditor;
		if (editor && session?.state === 'ready' && accounts.forUri(editor.document.uri) === session) {
			const info = parseSourceFile(editor.document.uri, session.config!, editor.document.getText());
			if (info) { provider?.renderView(info); }
		}
	}));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		if (!editor || isPracticeUri(editor.document.uri)) { return; }
		const session = accounts.forUri(editor.document.uri);
		if (session?.config && session !== accounts.current) { accounts.select(session.root); }
	}));
	provider = new ProblemInfoViewProvider(context.extensionUri, () => accounts.current?.server as OJ, () => accounts.current?.config as OJAssistConfig);
	registerCommands(context);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(ProblemInfoViewProvider.viewType, provider));
	context.subscriptions.push(vscode.commands.registerCommand('ojassist.reload', async (target?: vscode.Uri | string) => {
		const root = typeof target === 'string' ? vscode.Uri.parse(target) : target || accounts.current?.root || accounts.folder()?.uri;
		if (!root) { vscode.window.showInformationMessage('请先打开刷题文件夹'); return; }
		accounts.select(root);
		const session = await accounts.load(root);
		if (session.state !== 'ready') { vscode.window.showWarningMessage(session.message || '账号未就绪'); }
		return session.state;
	}));
	for (const folder of vscode.workspace.workspaceFolders || []) { void accounts.load(folder.uri); }
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
		for (const folder of event.removed) { accounts.remove(folder.uri); }
		for (const folder of event.added) { void accounts.load(folder.uri); }
	}));
	new DebuggerTimer().hook();
	if (context.extensionMode === vscode.ExtensionMode.Test) { return { accounts, submissions, backends }; }
}
export function deactivate() { }
