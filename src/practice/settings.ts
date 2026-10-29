import * as vscode from 'vscode';
import { RunOptions } from './runner';
import { tools } from './languages';

export function runOptions(source: vscode.Uri): RunOptions {
    const settings = vscode.workspace.getConfiguration('ojassist.practice', source);
    const timeout = Number(settings.get('timeLimit', 2));
    const options: any = { timeout: Math.max(100, Math.min(60000, (Number.isFinite(timeout) ? timeout : 2) * 1000)) };
    for (const [id, tool] of Object.entries(tools)) { options[id] = settings.get(tool.setting, tool.command); }
    return options;
}
