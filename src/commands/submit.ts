import * as vscode from 'vscode';
import { isPracticeUri, submitPractice } from '../practice/controller';
import { submitAccount } from '../account/controller';
import { safeMessage } from '../account/credentials';

export default vscode.commands.registerTextEditorCommand('ojassist.submit', async editor => {
    if (isPracticeUri(editor.document.uri)) {
        try { await submitPractice(editor.document.uri); }
        catch (error) { vscode.window.showWarningMessage(safeMessage(error)); }
        return;
    }
    return submitAccount(editor);
});
