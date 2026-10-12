import * as vscode from 'vscode';
import { OJ, OJAssistConfig, ProblemInfo } from "./model";
import { parseSourceFile, renderLatex, translateHtmlToChinese } from "./utils";
import { readFileSync } from 'fs';
import * as path from 'path';

let _view!: vscode.WebviewView;
export let view = _view;
export class ProblemInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ojassistant.problemInfoView';
    public currentProblem!: ProblemInfo;

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
            let sourceFile = parseSourceFile(editor.document.uri, config(), editor.document.getText());
            if (sourceFile === null) {
                return;
            }
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
            if (editor !== undefined) {
                const info = parseSourceFile(editor.document.uri, this.config(), editor.document.getText());
                if (info !== null) {
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
            switch (msg.command) {
                case 'copy':
                    vscode.env.clipboard.writeText(msg.text);
                    vscode.window.showInformationMessage("OJ-Assistant: Sample input copied.");
                    break;
                case 'run':
                    break;
                case 'edit':
                    vscode.commands.executeCommand('ojassist.data');
                    break;
                case 'translate':
                    void this.translateCurrent();
                    break;
            }
        });
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
        for (let i = 0; i < content.sampleInput.length; i++) {
            sampleIOs += `
            <div>
                <h2>
                    Sample#${i + 1}:
                    <button class="dot btn-copy" data-src="${i}">Copy</button>
                    <button class="dot btn-edit" data-src="${i}">Edit</button>
                </h2>
                <div id="sampleInput-${i}">${content.sampleInput[i]}</div>
                <h2>
                Output#${i + 1}:
                <!--
                <button class="dot btn-run" data-src="${i}">Run</button>
                -->
            </h2>
            <pre>${content.sampleOutput[i]}</pre>
            </div>
            `;
        }
        this._view.webview.html = this.currentTemplate.replace('{0}', `
            <h1 align="center">${content.title}</h1>
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
        return (this.config as any)?.translation ?? {};
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
        if (this.currentProblem !== undefined && this.currentProblem.id === problemInfo.id && this.currentProblem.contestId === problemInfo.contestId) { return; }
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
                    document.querySelectorAll('.btn-copy').forEach(el => {
                        el.addEventListener('click', () => {
                            let i = el.getAttribute('data-src');
                            vscode.postMessage({
                                command: 'copy',
                                text: document.getElementById('sampleInput-' + i).innerText,
                            });
                        });
                    });
                    document.querySelectorAll('.btn-edit').forEach(el => {
                        el.addEventListener('click', () => {
                            vscode.postMessage({ command: 'edit' });
                        });
                    });
                    document.querySelectorAll('.btn-translate').forEach(el => {
                        el.addEventListener('click', () => {
                            vscode.postMessage({ command: 'translate' });
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
        this.oj().getProblem(problemInfo).then(problem => {
            if (seq !== this.renderSeq) { return; } // a newer render superseded this one
            this.currentProblem = problemInfo;
            this.lastContent = problem.content;
            this.lastProblemInfo = problemInfo;
            this.isTranslated = false;
            this.paintProblem(problemInfo, problem.content);
        }).catch((err: Error) => {
            if (seq !== this.renderSeq) { return; }
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

    private getHtml(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'problem.js'));


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