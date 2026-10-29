import * as vscode from 'vscode';
import { OJ, OJAssistConfig, ProblemInfo } from "./model";
import { parseSourceFile, renderLatex, translateHtmlToChinese } from "./utils";
import { readFileSync } from 'fs';
import * as path from 'path';
import { accounts, isAuthenticationError } from './account/session';
import { problemSamples } from './account/sampleData';
import { escapeHtml } from './practice/problem';

let _view!: vscode.WebviewView;
export let view = _view;
export class ProblemInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ojassistant.problemInfoView';
    public currentProblem: ProblemInfo | undefined;
    private renderedServer: OJ | undefined;

    private _view!: vscode.WebviewView;
    /** Last rendered statement (for the translate button) + restore state. */
    private lastContent: any;
    private lastProblemInfo: ProblemInfo | undefined;
    private lastOriginal: any;
    private isTranslated = false;
    private translating = false;
    private currentTemplate = '';
    /** Processed KaTeX css (fonts rewritten to webview URIs), read once. */
    private katexCss: string | undefined;
    /** Last problem requested while the (collapsed) view did not exist yet. */
    private pendingProblem: ProblemInfo | undefined;
    private messageHandlerRegistered = false;
    /** Monotonic render token: a slow fetch must never overwrite a newer render. */
    private renderSeq = 0;
    private sourceUri: vscode.Uri | undefined;

    public invalidate(): void {
        this.renderSeq++;
        this.currentProblem = undefined;
        this.renderedServer = undefined;
        this.lastContent = undefined;
        this.lastProblemInfo = undefined;
        this.pendingProblem = undefined;
        this.sourceUri = undefined;
        if (this._view) { this._view.webview.html = '<p>账号状态已更新。打开题目代码文件后显示题面。</p>'; }
    }

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly oj: () => OJ,
        private readonly config: () => OJAssistConfig,
    ) {

        vscode.window.onDidChangeActiveTextEditor(editor => {
            // VS Code passes `undefined` (not null) when the last editor closes.
            if (!editor) {
                return null;
            }
            if (editor.document.uri.path.toLowerCase().endsWith('.in')) { return; }
            if (accounts.forUri(editor.document.uri) !== accounts.current || accounts.current?.state !== 'ready') { return; }
            let sourceFile = parseSourceFile(editor.document.uri, config(), editor.document.getText());
            if (sourceFile === null) {
                return;
            }
            this.sourceUri = editor.document.uri;
            this.renderView(sourceFile);
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): void | Thenable<void> {
        this._view = webviewView;
        view = webviewView;
        // Options MUST be set before the html - assigning them afterwards is
        // ignored by some VS Code versions, which silently disables scripts
        // (and with them the Copy/Edit buttons).
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'assets'),
                vscode.Uri.joinPath(this.extensionUri, 'assets', 'css'),
                vscode.Uri.joinPath(this.extensionUri, 'assets'),
                this.extensionUri,
                vscode.Uri.parse('vscode-webview://webviewview-ojassistant-probleminfoview')
            ]
        };
        webviewView.webview.html = '<h1 align="center">OJ-Assistant</h1>';
        this.registerMessageHandler();
        // The view starts collapsed, so the editor-change event usually fired
        // (and was dropped) before this view existed. Replay that request now,
        // or fall back to whatever file is currently focused.
        if (this.pendingProblem !== undefined) {
            this.renderView(this.pendingProblem);
        } else {
            const editor = vscode.window.activeTextEditor;
            if (editor !== undefined && !editor.document.uri.path.toLowerCase().endsWith('.in')) {
                const info = parseSourceFile(editor.document.uri, this.config(), editor.document.getText());
                if (info !== null) {
                    this.sourceUri = editor.document.uri;
                    this.renderView(info);
                }
            }
        }
    }

    /** Register the webview message channel exactly once. */
    private registerMessageHandler(): void {
        if (this.messageHandlerRegistered) { return; }
        this.messageHandlerRegistered = true;
        this._view.webview.onDidReceiveMessage(msg => {
            if (msg.seq !== this.renderSeq) { return; }
            switch (msg.command) {
                case 'copy':
                    vscode.env.clipboard.writeText(msg.text);
                    vscode.window.showInformationMessage("OJ-Assistant: Sample input copied.");
                    break;
                case 'run':
                    if (this.sourceUri) { void vscode.commands.executeCommand('ojassist.runAccountSamples', this.sourceUri); }
                    break;
                case 'tests':
                    if (this.sourceUri) { void vscode.commands.executeCommand('ojassist.accountTests', this.sourceUri); }
                    break;
                case 'submit':
                    if (this.sourceUri) { void vscode.commands.executeCommand('ojassist.submitAccountSource', this.sourceUri); }
                    break;
                case 'edit':
                    void this.editSample(msg.text);
                    break;
                case 'translate':
                    void this.translateCurrent();
                    break;
            }
        });
    }

    private async editSample(text: unknown): Promise<void> {
        try {
            if (typeof text !== 'string' || !this.sourceUri) {
                throw new Error('请先打开这道题的代码文件');
            }
            const source = await vscode.workspace.openTextDocument(this.sourceUri);
            const sourceFile = parseSourceFile(source.uri, this.config(), source.getText());
            if (!sourceFile || sourceFile.id !== this.currentProblem?.id || sourceFile.contestId !== this.currentProblem?.contestId) {
                throw new Error('当前代码文件与题面不匹配，请重新打开题目');
            }
            const inputUri = sourceFile.dataInputFile;
            let input: vscode.TextDocument;
            try {
                input = await vscode.workspace.openTextDocument(inputUri);
            } catch {
                await vscode.workspace.fs.writeFile(inputUri, new Uint8Array());
                input = await vscode.workspace.openTextDocument(inputUri);
            }
            const edit = new vscode.WorkspaceEdit();
            // HTML samples often contain NBSP, which formatted C++ input does not treat as whitespace.
            const sampleInput = text.replace(/[\u00a0\u202f]/g, ' ');
            edit.replace(inputUri, new vscode.Range(input.positionAt(0), input.positionAt(input.getText().length)), sampleInput);
            if (!await vscode.workspace.applyEdit(edit)) { throw new Error('写入样例失败'); }
            await input.save();
            await vscode.window.showTextDocument(input, { preview: false });
            vscode.window.showInformationMessage('样例已写入 ' + inputUri.path.split('/').pop() + '。回到代码文件，右键选择 Run Code 测试。');
        } catch (err: any) {
            vscode.window.showErrorMessage('OJ-Assistant: ' + (err?.message ?? err));
        }
    }

    /**
     * KaTeX css inlined into the template: external <link> loading (and the
     * leftover CDN integrity attribute) silently failed in some environments,
     * leaving MathML raw text visible in the panel.
     */
    private getKatexCss(): string {
        if (this.katexCss === undefined) {
            try {
                const cssPath = path.join(this.extensionUri.fsPath, 'assets', 'katex', 'katex.min.css');
                let css = readFileSync(cssPath, 'utf8');
                const fontsBase = this._view.webview.asWebviewUri(
                    vscode.Uri.joinPath(this.extensionUri, 'assets', 'katex')).toString();
                css = css.replace(/url\(fonts\//g, 'url(' + fontsBase + '/fonts/');
                this.katexCss = css;
            } catch (err) {
                console.error('OJ-Assistant: failed to inline katex css', err);
                this.katexCss = '';
            }
        }
        return this.katexCss;
    }

    /** Paint a (possibly translated) statement into the webview. */
    private paintProblem(problemInfo: ProblemInfo, content: any): void {
        let sampleIOs = ``;
        const samples = problemSamples(this.config()?.backend || '', content);
        for (let i = 0; i < samples.length; i++) {
            sampleIOs += `
            <div>
                <h2>
                    Sample#${i + 1}:
                    <button class="dot btn-copy" data-src="${i}">Copy</button>
                    <button class="dot btn-edit" data-src="${i}">Edit</button>
                </h2>
                <div id="sampleInput-${i}"><pre>${escapeHtml(samples[i].input)}</pre></div>
                <h2>
                Output#${i + 1}:
                <!--
                <button class="dot btn-run" data-src="${i}">Run</button>
                -->
            </h2>
            <pre>${escapeHtml(samples[i].output)}</pre>
            </div>
            `;
        }
        this._view.webview.html = this.currentTemplate.replace('{0}', `
            <div><button class="dot" data-account-command="run">运行全部样例</button><button class="dot" data-account-command="tests">样例与自定义测试</button><button class="dot" data-account-command="submit">提交当前代码</button></div>
            <h1 align="center">${escapeHtml(String(content.title))}</h1>
                <div align="center" style="margin-bottom:8px;"><button class="dot btn-translate">${content.__translated ? '✓ 已翻译（点击还原）' : '🌐 翻译成中文'}</button></div>
            <div>
                <h2>Description:</h2>
                <p>${renderLatex(content.desc)}</p>
            </div>
            <div>
                <h2>Input:</h2>
                <p>${renderLatex(content.input)}</p>
            </div>
            <div>
                <h2>Output:</h2>
                <p>${renderLatex(content.output)}</p>
            </div>
            
            <div>
            ${sampleIOs}
            </div>

            <div>
                <h2>Note:</h2>
                <p>${renderLatex(content.note ?? 'None')}</p>
            </div>
        `);
        const meta = (content as any).viewMeta as string | undefined;
        this._view.title = meta ? `OJ: Problem#${problemInfo.id} · ${meta}` : `OJ: Problem#${problemInfo.id}`;
    }

    /** Translate the current statement EN -> ZH (or restore the original). */
    /** Provider config from .ojassistconfig.json (`translation` section). */
    private translateOptions(): any {
        return (this.config() as any)?.translation ?? {};
    }

    private async translateCurrent(): Promise<void> {
        if (!this.lastContent || !this.lastProblemInfo || this.translating) { return; }
        const info = this.lastProblemInfo;
        if (this.isTranslated) {
            this.isTranslated = false;
            this.paintProblem(info, this.lastOriginal ?? this.lastContent);
            return;
        }
        this.translating = true;
        try {
            const src = this.lastContent;
            this.lastOriginal = src;
            this._view.webview.html = this.currentTemplate.replace('{0}', `
                <div align="center" style="font-size: 32px;">
                    <div><span class="oa-loading">&#8635;</span> 翻译中...</div>
                </div>`);
            const [desc, input, output, note] = await Promise.all([
                translateHtmlToChinese(String(src.desc ?? ''), this.translateOptions()),
                translateHtmlToChinese(String(src.input ?? ''), this.translateOptions()),
                translateHtmlToChinese(String(src.output ?? ''), this.translateOptions()),
                translateHtmlToChinese(String(src.note ?? ''), this.translateOptions()),
            ]);
            if (this.currentProblem !== info) { return; } // user switched away
            const translated = Object.assign({}, src, { desc, input, output, note, __translated: true });
            this.isTranslated = true;
            this.paintProblem(info, translated);
        } catch (err: any) {
            vscode.window.showErrorMessage('OJ-Assistant: 翻译失败: ' + (err?.message ?? err));
            this.paintProblem(info, this.lastOriginal ?? this.lastContent);
        } finally {
            this.translating = false;
        }
    }

    public renderView(problemInfo: ProblemInfo): void {
        if (problemInfo === undefined) { return; }
        if ((problemInfo as any).uri) { this.sourceUri = (problemInfo as any).uri; }
        const server = this.oj();
        if (this.renderedServer === server && this.currentProblem !== undefined && this.currentProblem.id === problemInfo.id && this.currentProblem.contestId === problemInfo.contestId) { return; }
        // Remember the request so resolveWebviewView can replay it once the
        // user expands the panel - previously this was silently dropped.
        this.pendingProblem = problemInfo;
        if (this._view === undefined) { return; }
        if (this.oj() === undefined) { return; } // backend still starting; replayed later
        const seq = ++this.renderSeq;
        const nonce = getNonce();
        const templateHtml = `<!DOCTYPE html>
        <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta
                    http-equiv="Content-Security-Policy"
                    content="default-src 'none';
                    img-src ${this._view.webview.cspSource} https: http: data: 'strict-dynamic';
                    script-src ${this._view.webview.cspSource} 'nonce-${nonce}';
                    style-src ${this._view.webview.cspSource} 'self' 'unsafe-inline' https:;
                    media-src ${this._view.webview.cspSource} vscode-webview: https:;
                    font-src  ${this._view.webview.cspSource} https: vscode-webview:"
                />

                <style nonce="${nonce}">
                    h2 {
                        font-size: 18px;
                    }
                    .dot {
                        border-radius: 4px;
                        background: transparent;
                        border: 1px dotted;
                        margin-left: 5px;
                        color: var(--vscode-editor-foreground);
                        border-color: var(--vscode-editor-foreground);
                        cursor: pointer;
                    }
                    .oa-loading {
                        display: inline-block;
                        animation: oa-spin 1s linear infinite;
                    }
                    @keyframes oa-spin {
                        to { transform: rotate(360deg); }
                    }
                    
                    @font-face {
                        font-family: 'Roboto Mono';
                        font-style: normal;
                        font-weight: 400;
                        src: local(''),
                            url('https://cdn.jsdelivr.net/gh/lss233/oj-assistant/assets/fonts/roboto-mono-v12-latin-regular.woff') format('woff2'),
                            url('https://cdn.jsdelivr.net/gh/lss233/oj-assistant/assets/fonts/roboto-mono-v12-latin-regular.woff') format('woff');
                    }
                    
                    pre,
                    code {
                        font-family: 'Roboto Mono';
                    }
                </style>
            </head>
            <body>{0}
                <!-- Handlers are attached synchronously BEFORE any external
                     resource loads - an unreachable CDN used to block
                     DOMContentLoaded and leave the Copy/Edit buttons dead. -->
                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    const seq = ${seq};
                    document.querySelectorAll('[data-account-command]').forEach(el => el.addEventListener('click', () => vscode.postMessage({command: el.getAttribute('data-account-command'), seq})));
                    document.querySelectorAll('.btn-copy').forEach(el => {
                        el.addEventListener('click', () => {
                            let i = el.getAttribute('data-src');
                            vscode.postMessage({
                                command: 'copy',
                                seq,
                                text: document.getElementById('sampleInput-' + i).innerText,
                            });
                        });
                    });
                    document.querySelectorAll('.btn-edit').forEach(el => {
                        el.addEventListener('click', () => {
                            let i = el.getAttribute('data-src');
                            vscode.postMessage({ command: 'edit', seq, text: document.getElementById('sampleInput-' + i).innerText });
                        });
                    });
                    document.querySelectorAll('.btn-translate').forEach(el => {
                        el.addEventListener('click', () => {
                            vscode.postMessage({ command: 'translate', seq });
                        });
                    });

                    window.addEventListener('message', event => {
                        const msg = event.data;
                        switch (msg.type) {
                            case 'playAudio':
                                let audio = new Audio(msg.src);
                                audio.play();
                                break;
                        }
                    });
                </script>
                <style nonce="${nonce}">${this.getKatexCss()}</style>
            </body>
        </html>
        `;
        this.currentTemplate = templateHtml;
        this._view.webview.html = templateHtml.replace('{0}', `
                <div align="center" style="font-size: 32px;">
                    <div>
                        <span class="oa-loading">&#8635;</span>
                        Loading...
                    </div>
                </div>
        `);
        server.getProblem(problemInfo).then(problem => {
            if (seq !== this.renderSeq || server !== this.oj()) { return; }
            this.renderedServer = server;
            this.currentProblem = problemInfo;
            this.lastContent = problem.content;
            this.lastProblemInfo = problemInfo;
            this.isTranslated = false;
            this.paintProblem(problemInfo, problem.content);
        }).catch((err: Error) => {
            if (seq !== this.renderSeq) { return; }
            if (isAuthenticationError(err) && accounts.current?.server === server) { accounts.change(accounts.current, 'expired', '登录已过期，请重新登录后打开题目'); return; }
            console.error(err);
            this._view.webview.html = templateHtml.replace('{0}', `
                <div align="center" style="font-size: 32px;">
                    <div>
                        ${err.message ?? 'Failed'}
                    </div>
                </div>
        `);
        });
    }

}
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
