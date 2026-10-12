import * as vscode from 'vscode';
import { OJ, OJAssistConfig, ProblemInfo } from "./model";
import { parseSourceFile, renderLatex } from "./utils";
import * as path from 'path';

let _view!: vscode.WebviewView;
export let view = _view;
export class ProblemInfoViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ojassistant.problemInfoView';
    public currentProblem!: ProblemInfo;

    private _view!: vscode.WebviewView;
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
            }
        });
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
                <!-- KaTeX styling is progressive enhancement: loaded after the
                     script so a slow CDN can never break the panel again. -->
                <link rel="stylesheet" href="${this._view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'katex', 'katex.min.css'))}" nonce="${nonce}">
            </body>
        </html>
        `;
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
            let sampleIOs = ``;
            for (let i = 0; i < problem.content.sampleInput.length; i++) {
                sampleIOs += `
                <div>
                    <h2>
                        Sample#${i + 1}:
                        <button class="dot btn-copy" data-src="${i}">Copy</button>
                        <button class="dot btn-edit" data-src="${i}">Edit</button>
                    </h2>
                    <div id="sampleInput-${i}">${problem.content.sampleInput[i]}</div>
                    <h2>
                    Output#${i + 1}:
                    <!--
                    <button class="dot btn-run" data-src="${i}">Run</button>
                    -->
                </h2>
                <pre>${problem.content.sampleOutput[i]}</pre>
                </div>
                `;
            }
            this._view.webview.html = templateHtml.replace('{0}', `
                <h1 align="center">${problem.content.title}</h1>
                <div>
                    <h2>Description:</h2>
                    <p>${renderLatex(problem.content.desc)}</p>
                </div>
                <div>
                    <h2>Input:</h2>
                    <p>${renderLatex(problem.content.input)}</p>
                </div>
                <div>
                    <h2>Output:</h2>
                    <p>${renderLatex(problem.content.output)}</p>
                </div>
                
                <div>
                ${sampleIOs}
                </div>

                <div>
                    <h2>Note:</h2>
                    <p>${renderLatex(problem.content.note ?? 'None')}</p>
                </div>
            `);
            const meta = (problem.content as any).viewMeta as string | undefined;
            this._view.title = meta ? `OJ: Problem#${problem.id} · ${meta}` : `OJ: Problem#${problem.id}`;
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
                }
            });
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