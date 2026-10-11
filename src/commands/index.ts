import * as vscode from 'vscode';

import Submit from './submit';
import Data from './data';
import DataFile from './dataFile';
import WebLogin from './webLogin';
import InitWorkspace from './initWorkspace';
import { ProblemTreeProvider, ProblemNode, openProblemFile } from '../problems/tree';
import { parseSourceFile } from '../utils';
import { config } from '../extension';

const commands: Array<vscode.Disposable> = [Submit, Data, DataFile, WebLogin, InitWorkspace];

/** Register one command; a failure must never block the others. */
function safePush(context: vscode.ExtensionContext, fn: () => vscode.Disposable, label: string): void {
    try {
        context.subscriptions.push(fn());
    } catch (err) {
        console.error('OJ-Assistant: failed to register ' + label, err);
    }
}

export function registerCommands(context: vscode.ExtensionContext) {
    // Tree-click handler FIRST. Tree items carry NO command arguments (see
    // tree.ts); the clicked item is resolved through TreeView.selection.
    let problemTreeView: vscode.TreeView<ProblemNode> | undefined;
    safePush(context, () => vscode.commands.registerCommand('ojassist.openProblem', (entry?: any) => {
        const target = entry?.id ? entry : problemTreeView?.selection?.[0]?.entry;
        if (target?.id) { openProblemFile(target); }
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
        const info = parseSourceFile(editor.document.uri, config, editor.document.getText());
        if (!info) {
            vscode.window.showWarningMessage('OJ-Assistant: 当前文件名不符合题目命名规则，无法定位网页地址。');
            return;
        }
        const url = problemWebUrl((config as any)?.backend, info);
        if (!url) {
            vscode.window.showWarningMessage('OJ-Assistant: 当前平台没有已知的网页地址规则。');
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }), 'ojassist.openProblemInBrowser');
}

/** Platform -> web page URL for a problem (fallback escape hatch). */
function problemWebUrl(backend: string | undefined, info: { id: string; contestId?: string }): string | undefined {
    switch (backend) {
        case 'luogu':
            return 'https://www.luogu.com.cn/problem/' + info.id.toUpperCase();
        case 'leetcode':
            return 'https://leetcode.cn/problems/' + info.id + '/';
        case 'neuoj':
            return info.contestId
                ? 'https://oj.neu.edu.cn/contests/' + info.contestId
                : 'https://oj.neu.edu.cn/problems/' + info.id;
        case 'csecg':
            return info.contestId
                ? 'http://neucsecg.neu.edu.cn/assignment/programList.jsp?proNum=' + info.id + '&assignID=' + info.contestId
                : 'http://neucsecg.neu.edu.cn/assignment/';
        case 'hnucg':
        case 'hnu-cg':
            return info.contestId
                ? 'https://cg.hnu.edu.cn/assignment/programList.jsp?proNum=' + info.id + '&assignID=' + info.contestId
                : 'https://cg.hnu.edu.cn/assignment/';
        case 'hnuacm':
        case 'hnu-acm':
            return 'http://acm.hnu.edu.cn/online/?action=problem&type=show&id=' + info.id;
        case 'codeforces': {
            if (info.contestId) {
                return 'https://codeforces.com/problemset/problem/' + info.contestId + '/' + info.id;
            }
            const m = info.id.match(/^(\d+)(.*)$/);
            return m ? 'https://codeforces.com/problemset/problem/' + m[1] + '/' + m[2] : undefined;
        }
        case 'fjutacm':
            return 'http://www.fjutacm.com/Problem.jsp?pid=' + info.id;
        default:
            return undefined;
    }
}
