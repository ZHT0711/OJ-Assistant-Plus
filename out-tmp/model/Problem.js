"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SourceFile = exports.Problem = exports.ProblemSubmit = void 0;
const vscode = require("vscode");
class ProblemSubmit {
}
exports.ProblemSubmit = ProblemSubmit;
class Problem {
    constructor(id, contestId, content) {
        this.id = id;
        this.contestId = contestId;
        this.content = content;
    }
}
exports.Problem = Problem;
class SourceFile {
    constructor(id, contestId, sourceType, code, uri, 
    /** Language chosen by the submit-time picker (overrides auto-map). */
    languageOverride) {
        this.id = id;
        this.contestId = contestId;
        this.sourceType = sourceType;
        this.code = code;
        this.uri = uri;
        this.languageOverride = languageOverride;
    }
    get dataInputFile() {
        if (this.contestId) {
            return vscode.Uri.joinPath(vscode.workspace.getWorkspaceFolder(this.uri).uri, this.contestId, `${this.id}.in`);
        }
        else {
            return vscode.Uri.joinPath(vscode.workspace.getWorkspaceFolder(this.uri).uri, `${this.id}.in`);
        }
    }
}
exports.SourceFile = SourceFile;
