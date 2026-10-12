import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ojServer, config } from '../extension';
import { ProblemListEntry } from '../model';

/** Node of the problem browser tree. */
export class ProblemNode {
    constructor(
        public readonly label: string,
        public readonly difficulty: string | undefined,
        public readonly entry?: ProblemListEntry,
        public readonly kind?: 'hint' | 'loading' | 'more' | 'action-submit' | 'action-browser' | 'group',
        /** For 'group' nodes: the assignment id whose problems it contains. */
        public readonly groupId?: string,
    ) { }
}

/**
 * "OJ Assistant" side panel: search the current platform's problem set and
 * create a solution file with one click - the Problem Info view then shows
 * the statement automatically (the generated names follow pathParseRule).
 */
export class ProblemTreeProvider implements vscode.TreeDataProvider<ProblemNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ProblemNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private entries: ProblemListEntry[] = [];
    private keyword = '';
    private page = 1;
    private hasMore = false;
    private loading = false;
    /** First page loaded at least once (auto-load on panel open). */
    private initialized = false;
    private lastError = '';
    private initRetries = 0;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    /** ↻ toolbar button: re-fetch page 1 of the current keyword. */
    async reload(): Promise<void> {
        this.page = 1;
        await this.loadPage(false);
    }

    async search(keyword: string): Promise<void> {
        this.keyword = keyword;
        this.page = 1;
        this.entries = [];
        await this.loadPage(false);
    }

    async loadMore(): Promise<void> {
        this.page += 1;
        await this.loadPage(true);
    }

    private async loadPage(append: boolean): Promise<void> {
        if (typeof ojServer?.searchProblems !== 'function') {
            this.refresh();
            return;
        }
        this.loading = true;
        this.refresh();
        try {
            const result = await ojServer.searchProblems!(this.keyword, this.page);
            this.entries = append ? this.entries.concat(result.problems) : result.problems;
            this.hasMore = result.hasMore;
            this.lastError = '';
        } catch (err: any) {
            this.lastError = String(err?.message ?? err);
            vscode.window.showErrorMessage(`OJ-Assistant: 加载题库失败: ${this.lastError}`);
        } finally {
            this.loading = false;
            this.initialized = true;
            this.refresh();
        }
    }

    getChildren(element?: ProblemNode): ProblemNode[] {
        if (element?.kind === 'group' && element.groupId !== undefined) {
            return this.getChildrenForGroup(element.groupId);
        }
        if (ojServer === undefined) {
            // Activation reads the config asynchronously - retry until the
            // backend instance exists, then the first page loads by itself.
            this.scheduleInitRetry();
            return [new ProblemNode('插件初始化中，稍候自动加载题库...', undefined, undefined, 'hint')];
        }
        if (typeof ojServer.searchProblems !== 'function') {
            const backend = (config as any)?.backend ?? '?';
            return [new ProblemNode(`平台 ${backend} 暂不支持在线搜题，请手动按命名规则新建题目文件`, undefined, undefined, 'hint')];
        }
        // Auto-load the first page as soon as the panel is opened.
        if (!this.initialized) {
            if (!this.loading) { void this.loadPage(false); }
            return [new ProblemNode('正在加载题库...', undefined, undefined, 'loading')];
        }
        if (this.loading && this.entries.length === 0) {
            return [new ProblemNode('加载中...', undefined, undefined, 'loading')];
        }
        if (this.entries.length === 0) {
            const hint = this.lastError
                ? `加载失败：${this.lastError}（点 ↻ 重试）`
                : this.keyword
                    ? `没有找到与 "${this.keyword}" 匹配的题目`
                    : '暂无题目，点 ↻ 重试';
            // Quick actions stay visible even here - the browser button is
            // exactly the escape hatch needed when loading fails.
            return [
                new ProblemNode('⬆️  提交当前题目', undefined, undefined, 'action-submit'),
                new ProblemNode('🌐  在浏览器打开当前题目', undefined, undefined, 'action-browser'),
                new ProblemNode(hint, undefined, undefined, 'hint'),
            ];
        }
        const nodes: ProblemNode[] = [
            // Pinned quick actions (no command arguments - see getTreeItem).
            new ProblemNode('⬆️  提交当前题目', undefined, undefined, 'action-submit'),
            new ProblemNode('🌐  在浏览器打开当前题目', undefined, undefined, 'action-browser'),
        ];

        const grouped = this.entries.length > 0 && this.entries.every(e => e.contestId !== undefined);
        if (grouped) {
            // One folder per assignment: name + deadline/countdown + 补交 badge
            // live on the folder; problem rows stay clean.
            const groups = new Map<string, ProblemListEntry[]>();
            for (const e of this.entries) {
                const key = String(e.contestId);
                if (!groups.has(key)) { groups.set(key, []); }
                groups.get(key)!.push(e);
            }
            for (const [assignID, list] of groups) {
                const meta = list[0];
                const label = formatGroupLabel(meta, list.length);
                nodes.push(new ProblemNode(label, undefined, undefined, 'group', assignID));
            }
        } else {
            nodes.push(...this.entries.map(e =>
                new ProblemNode(formatProblemLabel(e), e.difficulty, e)));
        }
        if (this.hasMore) {
            nodes.push(new ProblemNode('⬇ 加载更多...', undefined, undefined, 'more'));
        }
        return nodes;
    }

    /** Children of an assignment folder: its problems (clean labels). */
    getChildrenForGroup(groupId: string): ProblemNode[] {
        return this.entries
            .filter(e => String(e.contestId) === groupId)
            .map(e => new ProblemNode(`${e.id}  ${e.title}`, describeEntry(e), e));
    }

    private scheduleInitRetry(): void {
        if (this.initRetries >= 15 || this.retryTimer !== undefined) { return; }
        this.initRetries += 1;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.refresh();
        }, 800);
    }

    getTreeItem(node: ProblemNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.label,
            node.kind === 'group'
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None);
        if (node.kind === 'group') {
            item.id = 'g:' + node.groupId;
            item.iconPath = new vscode.ThemeIcon(node.groupId && this.entries.some(e => String(e.contestId) === node.groupId && e.history) ? 'history' : 'folder');
            item.contextValue = 'assignmentGroup';
            return item;
        }
        if (node.entry) {
            // MUST be unique across the whole tree: every assignment has a
            // "problem 1", and VS Code aliases tree nodes by id - a bare
            // `p:1` made clicking 3897's #1 open 3885's #1 instead.
            item.id = `p:${node.entry.contestId ?? '-'}:${node.entry.id}`;
            item.tooltip = `${node.entry.id} - ${node.entry.title}`;
            item.description = describeEntry(node.entry);
            // NOTE: intentionally NO arguments - VS Code routes commands with
            // arguments through CommandsConverter, whose per-item cache is
            // wiped on every tree refresh, breaking all clicks. The handler
            // reads TreeView.selection instead.
            item.command = { command: 'ojassist.openProblem', title: 'Open problem' };
            item.iconPath = new vscode.ThemeIcon('file-code');
        } else if (node.kind === 'action-submit') {
            item.command = { command: 'ojassist.quickSubmit', title: 'Submit current problem' };
            item.iconPath = new vscode.ThemeIcon('cloud-upload');
            item.description = 'OJ-Assist: Submit';
        } else if (node.kind === 'action-browser') {
            item.command = { command: 'ojassist.openProblemInBrowser', title: 'Open in browser' };
            item.iconPath = new vscode.ThemeIcon('globe');
            item.description = 'fallback';
        } else if (node.kind === 'more') {
            item.command = { command: 'ojassist.loadMoreProblems', title: 'Load more' };
            item.iconPath = new vscode.ThemeIcon('chevron-down');
        } else {
            item.description = undefined;
            item.iconPath = new vscode.ThemeIcon('info');
        }
        return item;
    }
}

const cppTemplate = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
`;

const leetcodeTemplate = `// 在力扣题目页右侧复制代码骨架粘贴到这里并实现，
// 然后 Ctrl+Shift+P -> "OJ-Assist: Submit this code" 提交。
class Solution {
public:

};
`;

/** Create (if needed) and open the solution file for a problem. */
export async function openProblemFile(entry: ProblemListEntry): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('OJ-Assistant: 请先打开一个工作区文件夹。');
        return;
    }
    const backend = (config as any)?.backend ?? 'luogu';
    let relative: string;
    let template: string;
    switch (backend) {
        case 'leetcode':
            relative = path.join('problems', `${entry.id}.cpp`);
            template = leetcodeTemplate;
            break;
        case 'neuoj':
            relative = path.join('problems', `${entry.id}.cpp`);
            template = cppTemplate;
            break;
        case 'csecg':
            relative = path.join('a', String(entry.contestId ?? '0'), `${entry.id}.cpp`);
            template = cppTemplate;
            break;
        case 'hnucg':
        case 'hnu-cg':
            relative = path.join('a', String(entry.contestId ?? '0'), `${entry.id}.cpp`);
            template = cppTemplate;
            break;
        case 'hnuacm':
        case 'hnu-acm':
            relative = path.join('problems', `${entry.id}.cpp`);
            template = cppTemplate;
            break;
        default:
            // luogu: P1001.cpp in the workspace root; anything else keeps id as-is.
            relative = `${entry.id}.cpp`;
            template = cppTemplate;
            break;
    }
    const fileUri = vscode.Uri.joinPath(folder.uri, relative);
    try {
        await fs.stat(fileUri.fsPath);
    } catch {
        await fs.mkdir(path.dirname(fileUri.fsPath), { recursive: true });
        await fs.writeFile(fileUri.fsPath, template, 'utf8');
    }
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document, { preview: false });
}

/** "〔09-22交·截10-18·剩8天〕 1 实验..." - dates in front of the title. */
function formatProblemLabel(e: ProblemListEntry): string {
    const parts: string[] = [];
    if (e.submittedAt) {
        parts.push(shortDate(e.submittedAt) + '交');
    }
    if (e.deadline) {
        parts.push('截' + shortDate(e.deadline) + countdown(e.deadline));
    }
    const prefix = parts.length > 0 ? '〔' + parts.join('·') + '〕 ' : '';
    return prefix + `${e.id}  ${e.title}`;
}

/** "2026-09-22 19:40:05" -> "09-22" (keeps HH:MM when given before midnight). */
function shortDate(s: string): string {
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
    if (!m) { return s.slice(0, 10); }
    return m[2] + '-' + m[3];
}

/** Human countdown to a deadline; recomputed on every tree render. */
function countdown(deadline: string): string {
    const m = deadline.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) { return ''; }
    const target = new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] ?? 23), Number(m[5] ?? 59), Number(m[6] ?? 59));
    const diffMs = target.getTime() - Date.now();
    if (diffMs <= 0) { return '已截止'; }
    const hours = Math.floor(diffMs / 3600000);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        return '·剩' + days + '天';
    }
    if (hours >= 1) { return '·剩' + hours + '小时'; }
    return '·剩' + Math.max(1, Math.floor(diffMs / 60000)) + '分';
}

/** "📁 第3次课后作业 〔截10-18·剩8天〕" / "…〔补交中·截10-04·已截止〕" */
function formatGroupLabel(meta: ProblemListEntry, count: number): string {
    const name = meta.assignmentName ?? ('作业 ' + meta.contestId);
    const parts: string[] = [];
    if (meta.history) { parts.push('历史'); }
    if (meta.late) { parts.push('补交中'); }
    if (meta.deadline) {
        parts.push('截' + shortDate(meta.deadline) + countdown(meta.deadline));
    }
    const suffix = parts.length > 0 ? ' 〔' + parts.join('·') + '〕' : '';
    return `📁 ${name}${suffix}`;
}

/** Row description: "10-09交 ✓ 10.00分" / "✓ 已AC" / "难度1". */
function describeEntry(e: ProblemListEntry): string | undefined {
    const bits: string[] = [];
    if (e.submittedAt) { bits.push(shortDate(e.submittedAt) + '交'); }
    if (e.status) { bits.push(e.status); }
    else if (e.difficulty) { bits.push(e.difficulty); }
    return bits.length > 0 ? bits.join(' ') : undefined;
}
