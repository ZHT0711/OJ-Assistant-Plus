import * as vscode from 'vscode';
import { config, ojServer } from '../extension';
import { parseSourceFile } from '../utils';

/** Last language chosen in this session (preselected next time). */
let lastPickedLanguage: string | number | undefined;

export default vscode.commands.registerTextEditorCommand('ojassist.submit', async (editor: vscode.TextEditor) => {
    vscode.window.withProgress({
        cancellable: false,
        location: vscode.ProgressLocation.Notification,
        title: `OJ-Assistant`
    }, (progress: vscode.Progress<{ increment: number, message: string }>, token: vscode.CancellationToken): Thenable<void> => {
        return new Promise(async resolve => {
            progress.report({
                increment: 10,
                message: `Preparing ...`
            });
            let sourceFile = parseSourceFile(editor.document.uri, config, editor.document.getText());
            if (sourceFile === null) {
                vscode.window.showErrorMessage(`OJ-Assistant: This is not a valid source code.`);
                resolve();
                return null;
            }
            // Multi-language support: ask which language to submit as.
            if ((config as any)?.askLanguage !== false && typeof ojServer?.listLanguages === 'function') {
                const languages = ojServer.listLanguages!();
                if (languages.length > 1) {
                    const configured = (config as any)?.languages?.[sourceFile.sourceType];
                    const remembered = lastPickedLanguage ?? configured;
                    const items = languages.map(l => ({
                        label: l.label,
                        detail: remembered !== undefined && String(l.value) === String(remembered) ? '✓ 默认' : undefined,
                        value: l.value,
                    }));
                    const picked = await vscode.window.showQuickPick(items, {
                        placeHolder: `选择提交语言（当前文件按扩展名推断: ${sourceFile.sourceType}）`,
                        matchOnDetail: true,
                    }) as { label: string; detail?: string; value: string | number } | undefined;
                    if (picked === undefined) {
                        resolve();
                        return null; // user cancelled
                    }
                    sourceFile.languageOverride = picked.value;
                    lastPickedLanguage = picked.value;
                }
            }
            progress.report({
                increment: 10,
                message: ` Problem#${sourceFile?.id} Uploading your code ...`
            });
            let resolver = await ojServer.submit(sourceFile);
            progress.report({
                increment: 30,
                message: ` Problem#${sourceFile?.id} Waiting for judgement ...`
            });
            try {
                let pendingJudgement = true;
                while (pendingJudgement) { // Polling
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Delay 1 sec.
                    let submit = await resolver();

                    progress.report({
                        increment: 1,
                        message: ` Problem#${sourceFile?.id} Current status: ${submit.result}`
                    });

                    if (submit.result !== 'Pending...' && submit.result !== 'Judging...' && submit.result !== 'Queuing') {

                        if (!pendingJudgement) { return; }
                        pendingJudgement = false;
                        resolve();
                        const perf: string[] = [];
                        if (submit.time && submit.time !== '-') { perf.push('⏱ ' + submit.time); }
                        if (submit.memory && submit.memory !== '-') { perf.push('💾 ' + submit.memory); }
                        const perfText = perf.length > 0 ? '  ' + perf.join('  ') : '';
                        const message = `OJ-Assistant: Problem#${sourceFile?.id} Result: ${submit.result}!${perfText}`;
                        if (submit.result !== 'Accepted') {
                            vscode.window.showErrorMessage(message);
                        } else {
                            vscode.window.showInformationMessage(message);
                        }
                    }
                }
            } catch (err) {
                resolve();
                vscode.window.showErrorMessage(`OJ-Assistant: Problem#${sourceFile?.id} Submit Error.`, err);
            }
        });
    });
})