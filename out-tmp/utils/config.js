"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfiguration = void 0;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
async function exists(filename) {
    console.log(filename);
    try {
        await fs.promises.stat(filename);
        return true;
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            return false;
        }
        else {
            throw err;
        }
    }
}
async function getConfiguration(fromPath) {
    let dirname = path.dirname(fromPath.fsPath);
    while (!await exists(dirname + '/.ojassistconfig.json')) {
        dirname = path.resolve(dirname, '..');
        if (!dirname.startsWith(vscode.workspace.getWorkspaceFolder(fromPath).uri.fsPath)) {
            return undefined;
        }
    }
    let data = await fs.promises.readFile(dirname + '/.ojassistconfig.json', 'utf-8');
    return JSON.parse(data);
}
exports.getConfiguration = getConfiguration;
