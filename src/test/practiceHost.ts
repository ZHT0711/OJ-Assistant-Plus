import * as assert from 'assert';
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseManual } from '../practice/problem';
import { problemDir, saveProblem } from '../practice/store';
import { readProblemLanguage, saveProblemLanguage } from '../practice/solutions';
import { CaseResult } from '../practice/runner';

/** Run in an isolated VS Code Extension Development Host, with no account config. */
export async function run(): Promise<void> {
    const extension = vscode.extensions.getExtension('skowosy.oj-assistant-plus');
    assert.ok(extension, 'extension is discoverable');
    await extension!.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const name of ['importLink', 'importPracticeJson', 'openPractice', 'runSamples', 'refreshPractice', 'submit', 'initWorkspace', 'pickPracticeLanguage', 'checkPracticeTools']) {
        assert.ok(commands.includes('ojassist.' + name), name + ' registered without account configuration');
    }
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const settings = vscode.workspace.getConfiguration('ojassist.practice', vscode.Uri.file(root));
    await settings.update('language', 'cpp', vscode.ConfigurationTarget.WorkspaceFolder);
    const p = parseManual({ url: 'https://example.com/problem/host-smoke', name: 'Host integration A+B', tests: [{ input: '1 2\n', output: '3\n' }] });
    await saveProblem(root, p, true);
    await saveProblemLanguage(root, p.key, 'cpp');
    const panels: vscode.WebviewPanel[] = [];
    const originalCreate = vscode.window.createWebviewPanel;
    let receive: ((msg: any) => void) | undefined;
    (vscode.window as any).createWebviewPanel = (...args: any[]) => {
        const panel = (originalCreate as any)(...args) as vscode.WebviewPanel;
        if (args[0] === 'ojassist.practiceStatement') {
            panels.push(panel);
            const originalEvent = panel.webview.onDidReceiveMessage;
            (panel.webview as any).onDidReceiveMessage = (listener: (msg: any) => void, ...rest: any[]) => {
                receive = listener;
                return (originalEvent as any)(listener, ...rest);
            };
        }
        return panel;
    };
    try {
    await vscode.commands.executeCommand('ojassist.refreshPractice');
    await vscode.commands.executeCommand('ojassist.openPractice', { problem: p, root });
    const source = path.join(problemDir(root, p.key), 'main.cpp');
    assert.ok((await fs.readFile(source, 'utf8')).includes('int main'));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await doc.save();
    await vscode.commands.executeCommand('ojassist.openPractice', { problem: p, root });
    assert.ok(doc.getText().includes('std::cout<<a+b'), 'reopening preserves user code');
    await vscode.window.showTextDocument(doc);
    const results = await vscode.commands.executeCommand<Array<{ passed: boolean }>>('ojassist.runSamples');
    assert.ok(results && results.length === 1 && results[0].passed, 'sample command returns a passing real C++ run');
    assert.strictEqual(panels.length, 1);
    assert.ok(panels[0].webview.html.includes('选择做题语言'), 'statement contains a visible language selector');
    await vscode.commands.executeCommand('ojassist.pickPracticeLanguage', 'py', { problem: p, root });
    const pythonUri = vscode.Uri.file(path.join(problemDir(root, p.key), 'main.py'));
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, pythonUri.fsPath);
    assert.strictEqual(await readProblemLanguage(root, p.key), 'py');
    const pythonDoc = await vscode.workspace.openTextDocument(pythonUri);
    const pythonEdit = new vscode.WorkspaceEdit();
    pythonEdit.replace(pythonUri, new vscode.Range(pythonDoc.positionAt(0), pythonDoc.positionAt(pythonDoc.getText().length)), 'import sys\na,b=map(int,sys.stdin.buffer.read().split())\nprint(a+b)\n');
    await vscode.workspace.applyEdit(pythonEdit);
    const pyResults = await vscode.commands.executeCommand<CaseResult[]>('ojassist.runSamples');
    assert.ok(pyResults?.[0].passed, 'Python sample runs after selecting language');
    await vscode.commands.executeCommand('ojassist.pickPracticeLanguage', 'cpp', { problem: p, root });
    assert.ok(vscode.window.activeTextEditor?.document.getText().includes('std::cout<<a+b'), 'C++ solution survives roundtrip');
    await vscode.commands.executeCommand('ojassist.pickPracticeLanguage', 'py', { problem: p, root });
    assert.ok(vscode.window.activeTextEditor?.document.getText().includes('print(a+b)'), 'Python solution survives roundtrip');
    const checks = await vscode.commands.executeCommand<Array<{ available: boolean }>>('ojassist.checkPracticeTools', 'py');
    assert.ok(checks?.every(c => c.available), 'tool check command uses selected language');
    const second = parseManual({ url: 'https://example.com/problem/second-host-smoke', name: 'Second integration problem', tests: [{ input: '4 5\n', output: '9\n' }] });
    await saveProblem(root, second, true);
    await saveProblemLanguage(root, second.key, 'c');
    const oldEpoch = Number(/const epoch=(\d+)/.exec(panels[0].webview.html)![1]);
    await Promise.all(Array.from({ length: 16 }, (_, i) => vscode.commands.executeCommand('ojassist.openPractice', { root, problem: i % 2 ? second : p })));
    assert.ok(vscode.window.activeTextEditor?.document.uri.fsPath.includes(second.key), 'last problem wins rapid switching');
    assert.ok(vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('main.c'));
    assert.ok(panels[0].webview.html.includes(second.title), 'statement matches latest source');
    assert.ok(panels[0].title.includes('C 11'));
    assert.strictEqual(panels.length, 1, 'switching reuses one statement panel');
    receive!({ epoch: oldEpoch, command: 'add', samples: [{ input: 'wrong problem', output: 'wrong' }] });
    await vscode.commands.executeCommand('ojassist.pickPracticeLanguage', 'c', { root, problem: second });
    const persisted = JSON.parse(await fs.readFile(path.join(problemDir(root, second.key), 'problem.json'), 'utf8'));
    assert.deepStrictEqual(persisted.samples, second.samples, 'stale page action cannot change latest tests');
    const currentEpoch = Number(/const epoch=(\d+)/.exec(panels[0].webview.html)![1]);
    receive!({ epoch: currentEpoch, command: 'language', language: 'js', samples: [{ input: '6 7\n', output: '13\n' }] });
    // Commands wait for queued webview edits, so this also validates selector message routing.
    await vscode.commands.executeCommand('ojassist.pickPracticeLanguage', 'js', { root, problem: second });
    assert.ok(vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('main.js'));
    assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(problemDir(root, second.key), 'problem.json'), 'utf8')).samples, [{ input: '6 7\n', output: '13\n' }], 'language dropdown preserves edited tests');
    assert.strictEqual(await fs.access(path.join(root, '.ojassistconfig.json')).then(() => true, () => false), false);
    await vscode.commands.executeCommand('ojassist.removePractice', { problem: p, root });
    assert.ok((await fs.readFile(source, 'utf8')).includes('std::cout<<a+b'), 'remove preserves code');
    await vscode.commands.executeCommand('ojassist.removePractice', { problem: second, root });
    console.log('PRACTICE_HOST_PASS: language picker, dropdown messages, C++/Python runs, tool detection, code preservation, rapid switching, stale action protection');
    } finally {
        (vscode.window as any).createWebviewPanel = originalCreate;
        await settings.update('language', 'cpp', vscode.ConfigurationTarget.WorkspaceFolder);
    }
}
