import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { adapterFor } from '../backend';
import { getPreferredLanguage, languageFileExt } from '../utils/languageState';
import { ProblemListEntry } from '../model';
import { accounts, isAuthenticationError } from '../account/session';
import { SubmissionRecord } from '../account/submissions';
import { languageById } from '../practice/languages';

/** Node of the problem browser tree. */
export class ProblemNode {
    constructor(
        public readonly label: string,
        public readonly difficulty: string | undefined,
        public readonly entry?: ProblemListEntry,
        public readonly kind?: 'hint' | 'loading' | 'more' | 'action-submit' | 'action-browser' | 'action-language' | 'action-init' | 'action-account' | 'action-tests' | 'action-history' | 'action-resume' | 'group',
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
    private requestSeq = 0;
    private sessionStamp = '';
    private verdicts = new Map<string, SubmissionRecord>();
    constructor() {
        accounts.onDidChange(session => {
            if (session !== accounts.current) { return; }
            const stamp = [session?.root.toString(), session?.generation, session?.state].join('|');
            if (stamp !== this.sessionStamp) {
                this.sessionStamp = stamp; this.requestSeq++; this.entries = []; this.page = 1; this.keyword = '';
                this.loading = false; this.initialized = false; this.hasMore = false; this.lastError = ''; this.verdicts.clear();
            }
            this.refresh();
        });
    }
    applyVerdict(record: SubmissionRecord): void {
        const session = accounts.current;
        if (record.sessionKey !== session?.key) { return; }
        this.verdicts.set(`${record.contestId || ''}|${record.problemId}`, record);
        this.refresh();
    }
    private actions(): ProblemNode[] {
        const session = accounts.current;
        const labels: { [key: string]: string } = { loading: '登录中…', ready: '已登录', expired: '需要重新登录', error: '连接失败', unconfigured: '未配置', untrusted: '工作区未信任' };
        return [
            new ProblemNode(`${session?.config?.backend || '账号'} · ${session?.username || ''} · ${labels[session?.state || 'unconfigured']}`, session?.message, undefined, 'action-account'),
            ...(session?.state === 'ready' ? [new ProblemNode(formatLanguageLabel(), undefined, undefined, 'action-language'),
                new ProblemNode('运行当前题目全部样例', undefined, undefined, 'action-tests'),
                new ProblemNode('⬆️  提交当前题目', undefined, undefined, 'action-submit'),
                new ProblemNode('查看提交历史', undefined, undefined, 'action-history'),
                new ProblemNode('继续查询评测', undefined, undefined, 'action-resume'),
                new ProblemNode('🌐  在浏览器打开当前题目', undefined, undefined, 'action-browser')] : []),
        ];
    }

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
        if (this.loading || !this.hasMore) { return; }
        this.page += 1;
        await this.loadPage(true);
    }

    private async loadPage(append: boolean): Promise<void> {
        const session = accounts.current;
        const server = session?.state === 'ready' ? session.server : undefined;
        if (!server || typeof server.searchProblems !== 'function') {
            this.refresh();
            return;
        }
        this.loading = true;
        const seq = ++this.requestSeq;
        this.refresh();
        try {
            const result = await server.searchProblems!(this.keyword, this.page);
            if (seq !== this.requestSeq || server !== accounts.current?.server) { return; }
            this.entries = append ? this.entries.concat(result.problems) : result.problems;
            this.hasMore = result.hasMore;
            this.lastError = '';
        } catch (err: any) {
            if (seq !== this.requestSeq || server !== accounts.current?.server) { return; }
            if (isAuthenticationError(err) && accounts.current) { accounts.change(accounts.current, 'expired', '登录已过期，请重新登录后刷新题库'); return; }
            this.lastError = String(err?.message ?? err);
            vscode.window.showErrorMessage(`OJ-Assistant: 加载题库失败: ${this.lastError}`);
        } finally {
            if (seq === this.requestSeq) {
                this.loading = false;
                this.initialized = true;
                this.refresh();
            }
        }
    }

    getChildren(element?: ProblemNode): ProblemNode[] {
        if (element?.kind === 'group' && element.groupId !== undefined) {
            return this.getChildrenForGroup(element.groupId);
        }
        const session = accounts.current;
        if (!session || session.state !== 'ready' || !session.server) {
            // Activation reads the config asynchronously - retry until the
            // backend instance exists, then the first page loads by itself.
            this.scheduleInitRetry();
            return [...this.actions(), new ProblemNode('初始化账号工作区 / 登录平台', undefined, undefined, 'action-init'),
                new ProblemNode('免登录请使用下方“链接刷题”', undefined, undefined, 'hint')];
        }
        const server = session.server;
        if (typeof server.searchProblems !== 'function') {
            const backend = session.config?.backend ?? '?';
            return [...this.actions(), new ProblemNode(`平台 ${backend} 暂不支持在线搜题，请手动按命名规则新建题目文件`, undefined, undefined, 'hint')];
        }
        // Auto-load the first page as soon as the panel is opened.
        if (!this.initialized) {
            if (!this.loading) { void this.loadPage(false); }
            return [...this.actions(), new ProblemNode('正在加载题库...', undefined, undefined, 'loading')];
        }
        if (this.loading && this.entries.length === 0) {
            return [...this.actions(), new ProblemNode('加载中...', undefined, undefined, 'loading')];
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
                ...this.actions(),
                new ProblemNode(hint, undefined, undefined, 'hint'),
            ];
        }
        const nodes: ProblemNode[] = [
            // Pinned quick actions (no command arguments - see getTreeItem).
            ...this.actions(),
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
            const recent = this.verdicts.get(`${node.entry.contestId || ''}|${node.entry.id}`);
            // MUST be unique across the whole tree: every assignment has a
            // "problem 1", and VS Code aliases tree nodes by id - a bare
            // `p:1` made clicking 3897's #1 open 3885's #1 instead.
            item.id = `p:${node.entry.contestId ?? '-'}:${node.entry.id}`;
            item.tooltip = `${node.entry.id} - ${node.entry.title}`;
            item.description = describeEntry(node.entry);
            if (recent?.verdict) { item.description = `${recent.verdict.result === 'Accepted' ? '✓ 已AC' : recent.verdict.result} · ${item.description || ''}`; }
            // NOTE: intentionally NO arguments - VS Code routes commands with
            // arguments through CommandsConverter, whose per-item cache is
            // wiped on every tree refresh, breaking all clicks. The handler
            // reads TreeView.selection instead.
            item.command = { command: 'ojassist.openProblem', title: 'Open problem' };
            item.iconPath = new vscode.ThemeIcon('file-code');
        } else if (['action-account', 'action-tests', 'action-history', 'action-resume'].includes(node.kind || '')) {
            const commands: any = { 'action-account': 'ojassist.accountStatus', 'action-tests': 'ojassist.runAccountSamples', 'action-history': 'ojassist.submissionHistory', 'action-resume': 'ojassist.resumeJudgement' };
            item.command = { command: commands[node.kind!], title: node.label };
            item.iconPath = new vscode.ThemeIcon(node.kind === 'action-account' ? 'account' : node.kind === 'action-tests' ? 'play' : 'history');
            if (node.kind === 'action-account') { item.tooltip = accounts.current?.message || node.label; }
        } else if (node.kind === 'action-init') {
            item.command = { command: 'ojassist.initWorkspace', title: '初始化账号工作区' };
            item.iconPath = new vscode.ThemeIcon('account');
        } else if (node.kind === 'action-language') {
            item.command = { command: 'ojassist.pickLanguage', title: 'Choose language' };
            item.iconPath = new vscode.ThemeIcon('symbol-enum');
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
    const session = accounts.current;
    if (!session?.server || session.state !== 'ready') {
        vscode.window.showErrorMessage('OJ-Assistant: 请先打开一个工作区文件夹。');
        return;
    }
    const backend = session.config?.backend || 'luogu';
    const adapter = adapterFor(backend);
    // Extension + template follow the language chosen in the panel (if any).
    const ext = languageFileExt(getPreferredLanguage());
    const template = adapter?.id === 'leetcode' && ext === 'cpp'
        ? leetcodeTemplate
        : templateForExtension(ext);
    const relative = adapter ? adapter.solutionPath(entry, ext) : `${entry.id}.${ext}`;
    const fileUri = vscode.Uri.joinPath(session.root, relative);
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

/** "🌐 语言：C++（点击切换）" - current solving language. */
function formatLanguageLabel(): string {
    const pref = getPreferredLanguage();
    return pref ? `🌐 语言：${pref.label}（点击切换）` : '🌐 语言：按文件扩展名自动（点击选择）';
}

/** Source template per language family (used when creating a solution file). */
export function templateForExtension(ext: string): string {
    const registered = languageById(ext);
    if (registered) { return registered.template.replace('cin.tie(nullptr)', 'cin.tie(0)'); }
    if (ext === 'java') {
        return ['import java.util.*;',
            'import java.io.*;',
            '',
            'public class Main {',
            '    public static void main(String[] args) {',
            '        Scanner cin = new Scanner(System.in);',
            '        ',
            '    }',
            '}',
            ''].join('\n');
    }
    if (ext === 'py' || ext === 'py3') {
        return ['import sys',
            '',
            'def main():',
            '    data = sys.stdin.read().split()',
            '    ',
            '',
            'if __name__ == "__main__":',
            '    main()',
            ''].join('\n');
    }
    if (ext === 'cs') {
        return ['using System;',
            '',
            'class Program {',
            '    static void Main() {',
            '        ',
            '    }',
            '}',
            ''].join('\n');
    }
    if (ext === 'c') {
        return ['#include <stdio.h>',
            '',
            'int main(void) {',
            '    ',
            '    return 0;',
            '}',
            ''].join('\n');
    }
    if (['cpp', 'cc', 'cxx'].includes(ext)) {
        return cppTemplate;
    }
    // go / kotlin / swift / rust / others: language-agnostic placeholder
    return `// language file extension: .${ext}
// TODO: solve the problem
`;
}
