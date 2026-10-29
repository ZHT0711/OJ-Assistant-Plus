import * as vscode from 'vscode';

import Submit from './submit';
import Data from './data';
import DataFile from './dataFile';
import WebLogin from './webLogin';
import InitWorkspace from './initWorkspace';
import QQToken from './qqToken';
import { ProblemTreeProvider, ProblemNode, openProblemFile } from '../problems/tree';
import * as path from 'path';
import { parseSourceFile } from '../utils';
import { getPreferredLanguage, setPreferredLanguage, languageFileExt } from '../utils/languageState';
import { adapterFor } from '../backend';
import { isPracticeUri, practiceForUri, registerPractice } from '../practice/controller';
import { registerAccountCommands } from '../account/controller';
import { accounts } from '../account/session';
import { SubmissionRecord } from '../account/submissions';

const commands: Array<vscode.Disposable> = [Submit, Data, DataFile, WebLogin, InitWorkspace, QQToken];

/** Register one command; a failure must never block the others. */
function safePush(context: vscode.ExtensionContext, fn: () => vscode.Disposable, label: string): void {
    try {
        context.subscriptions.push(fn());
    } catch (err) {
        console.error('OJ-Assistant: failed to register ' + label, err);
    }
}

export function registerCommands(context: vscode.ExtensionContext) {
    registerAccountCommands(context);
    registerPractice(context);
    // Tree-click handler FIRST. Tree items carry NO command arguments (see
    // tree.ts); the clicked item is resolved through TreeView.selection.
    let problemTreeView: vscode.TreeView<ProblemNode> | undefined;
    safePush(context, () => vscode.commands.registerCommand('ojassist.openProblem', async (entry?: any) => {
        const target = entry?.id ? entry : problemTreeView?.selection?.[0]?.entry;
        if (target?.id) { await openProblemFile(target); }
    }), 'ojassist.openProblem');

    for (const cmd of commands) {
        try { context.subscriptions.push(cmd); } catch (err) { console.error('OJ-Assistant: command register failed', err); }
    }

    // Built-in problem browser shown in the "OJ Assistant" activity bar view.
    const treeProvider = new ProblemTreeProvider();
    try {
        problemTreeView = vscode.window.createTreeView('ojassistant.problems', { treeDataProvider: treeProvider });
        context.subscriptions.push(problemTreeView);
    } catch (err) {
        console.error('OJ-Assistant: createTreeView failed', err);
    }
    safePush(context, () => vscode.commands.registerCommand('ojassist.searchProblems', async () => {
        const keyword = await vscode.window.showInputBox({
            prompt: '搜索题目（关键词/题号，留空列出全部）',
            ignoreFocusOut: true,
        });
        if (keyword === undefined) { return; }
        await treeProvider.search(keyword);
    }), 'ojassist.searchProblems');
    safePush(context, () => vscode.commands.registerCommand('ojassist.refreshProblems', () => treeProvider.reload()), 'ojassist.refreshProblems');
    safePush(context, () => vscode.commands.registerCommand('ojassist.pickLanguage', async () => {
        const server = accounts.current?.server;
        if (typeof server?.listLanguages !== 'function') {
            vscode.window.showWarningMessage('OJ-Assistant: 当前平台还没有可选语言列表。');
            return;
        }
        const languages = server.listLanguages!();
        if (languages.length === 0) { return; }
        const current = getPreferredLanguage();
        const items = languages.map((l: { value: string | number; label: string }) => ({
            label: (current && String(current.value) === String(l.value) ? '$(check) ' : '') + l.label,
            value: l.value,
            rawLabel: l.label,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: '选择本次做题使用的语言（影响生成文件的扩展名与提交语言）',
        }) as { value: string | number; rawLabel: string } | undefined;
        if (!picked) { return; }
        const choice = { value: picked.value, label: picked.rawLabel };
        setPreferredLanguage(choice);
        if (accounts.current) { await accounts.remember(accounts.current, languageFileExt(choice), choice); }
        await persistPreferredLanguage(picked.value);
        treeProvider.refresh();
    }), 'ojassist.pickLanguage');
    safePush(context, () => vscode.commands.registerCommand('ojassist.recordAccountVerdict', (record: SubmissionRecord) => treeProvider.applyVerdict(record)), 'ojassist.recordAccountVerdict');
    safePush(context, () => vscode.commands.registerCommand('ojassist.loadMoreProblems', () => treeProvider.loadMore()), 'ojassist.loadMoreProblems');

    // Pinned panel action: submit the problem of the file currently focused.
    safePush(context, () => vscode.commands.registerCommand('ojassist.quickSubmit', async () => {
        await vscode.commands.executeCommand('ojassist.submit');
    }), 'ojassist.quickSubmit');

    // Pinned panel action: open the problem page in the default browser.
    safePush(context, () => vscode.commands.registerCommand('ojassist.openProblemInBrowser', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('OJ-Assistant: 先打开一个题目代码文件，再点“在浏览器打开”。');
            return;
        }
        if (isPracticeUri(editor.document.uri)) {
            const practice = practiceForUri(editor.document.uri);
            if (practice) { await vscode.env.openExternal(vscode.Uri.parse(practice.url)); }
            return;
        }
        const session = accounts.forUri(editor.document.uri);
        const info = parseSourceFile(editor.document.uri, session?.config as any, editor.document.getText());
        if (!info) {
            vscode.window.showWarningMessage('OJ-Assistant: 当前文件名不符合题目命名规则，无法定位网页地址。');
            return;
        }
        const url = adapterFor(session?.config?.backend)?.webUrl(info);
        if (!url) {
            vscode.window.showWarningMessage('OJ-Assistant: 当前平台没有已知的网页地址规则。');
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }), 'ojassist.openProblemInBrowser');
}

/** Persist the language choice into .ojassistconfig.json (preferredLanguage). */
async function persistPreferredLanguage(value: string | number): Promise<void> {
    try {
        const session = accounts.current;
        if (!session) { return; }
        const file = path.join(session.root.fsPath, '.ojassistconfig.json');
        const { promises: fsp } = require('fs');
        const raw = await fsp.readFile(file, 'utf8');
        const indentMatch = raw.match(/^[ 	]+/m);
        const indent = indentMatch ? indentMatch[0].slice(0, 10) : '  ';
        const cfg = JSON.parse(raw);
        cfg.preferredLanguage = value;
        await fsp.writeFile(file, JSON.stringify(cfg, null, indent) + '\n', 'utf8');
    } catch (err) {
        console.error('OJ-Assistant: failed to persist preferredLanguage', err);
    }
}
