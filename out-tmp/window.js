"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProblemInfoViewProvider = exports.view = void 0;
const vscode = require("vscode");
const utils_1 = require("./utils");
const fs_1 = require("fs");
const path = require("path");
let _view;
exports.view = _view;
class ProblemInfoViewProvider {
    constructor(extensionUri, oj, config) {
        this.extensionUri = extensionUri;
        this.oj = oj;
        this.config = config;
        this.messageHandlerRegistered = false;
        /** Monotonic render token: a slow fetch must never overwrite a newer render. */
        this.renderSeq = 0;
        vscode.window.onDidChangeActiveTextEditor(editor => {
            // VS Code passes `undefined` (not null) when the last editor closes.
            if (!editor) {
                return null;
            }
            let sourceFile = utils_1.parseSourceFile(editor.document.uri, config(), editor.document.getText());
            if (sourceFile === null) {
                return;
            }
            this.renderView(sourceFile);
        });
    }
    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;
        exports.view = webviewView;
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
        }
        else {
            const editor = vscode.window.activeTextEditor;
            if (editor !== undefined) {
                const info = utils_1.parseSourceFile(editor.document.uri, this.config(), editor.document.getText());
                if (info !== null) {
                    this.renderView(info);
                }
            }
        }
    }
    /** Register the webview message channel exactly once. */
    registerMessageHandler() {
        if (this.messageHandlerRegistered) {
            return;
        }
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
    /**
     * KaTeX css inlined into the template: external <link> loading (and the
     * leftover CDN integrity attribute) silently failed in some environments,
     * leaving MathML raw text visible in the panel.
     */
    getKatexCss() {
        if (this.katexCss === undefined) {
            try {
                const cssPath = path.join(this.extensionUri.fsPath, 'assets', 'katex', 'katex.min.css');
                let css = fs_1.readFileSync(cssPath, 'utf8');
                const fontsBase = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'katex')).toString();
                css = css.replace(/url\(fonts\//g, 'url(' + fontsBase + '/fonts/');
                this.katexCss = css;
            }
            catch (err) {
                console.error('OJ-Assistant: failed to inline katex css', err);
                this.katexCss = '';
            }
        }
        return this.katexCss;
    }
    renderView(problemInfo) {
        if (problemInfo === undefined) {
            return;
        }
        if (this.currentProblem !== undefined && this.currentProblem.id === problemInfo.id && this.currentProblem.contestId === problemInfo.contestId) {
            return;
        }
        // Remember the request so resolveWebviewView can replay it once the
        // user expands the panel - previously this was silently dropped.
        this.pendingProblem = problemInfo;
        if (this._view === undefined) {
            return;
        }
        if (this.oj() === undefined) {
            return;
        } // backend still starting; replayed later
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
                <style nonce="${nonce}">${this.getKatexCss()}</style>
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
            if (seq !== this.renderSeq) {
                return;
            } // a newer render superseded this one
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
                    <p>${utils_1.renderLatex(problem.content.desc)}</p>
                </div>
                <div>
                    <h2>Input:</h2>
                    <p>${utils_1.renderLatex(problem.content.input)}</p>
                </div>
                <div>
                    <h2>Output:</h2>
                    <p>${utils_1.renderLatex(problem.content.output)}</p>
                </div>
                
                <div>
                ${sampleIOs}
                </div>

                <div>
                    <h2>Note:</h2>
                    <p>${utils_1.renderLatex(problem.content.note ?? 'None')}</p>
                </div>
            `);
            const meta = problem.content.viewMeta;
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
        }).catch((err) => {
            if (seq !== this.renderSeq) {
                return;
            }
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
    getHtml(webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'problem.js'));
    }
}
exports.ProblemInfoViewProvider = ProblemInfoViewProvider;
ProblemInfoViewProvider.viewType = 'ojassistant.problemInfoView';
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
