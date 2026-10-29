import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { languageById, PracticeLanguageId } from './languages';
import { problemDir } from './store';

export async function readProblemLanguage(root: string, key: string): Promise<PracticeLanguageId | undefined> {
    try {
        const state = JSON.parse(await fs.readFile(path.join(problemDir(root, key), 'language.json'), 'utf8'));
        return languageById(state.language)?.id;
    } catch { return undefined; }
}

export async function saveProblemLanguage(root: string, key: string, language: PracticeLanguageId): Promise<void> {
    if (!languageById(language)) { throw new Error('不支持的刷题语言'); }
    const file = path.join(problemDir(root, key), 'language.json');
    const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        await fs.writeFile(temp, JSON.stringify({ language }) + '\n', 'utf8');
        await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => undefined); }
}

/** Every language owns its file; changing language must never replace a solution. */
export async function ensureSolution(root: string, key: string, id: PracticeLanguageId): Promise<string> {
    const language = languageById(id);
    if (!language) { throw new Error('不支持的刷题语言'); }
    const dir = problemDir(root, key);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'main.' + language.id);
    try { await fs.writeFile(file, language.template, { encoding: 'utf8', flag: 'wx' }); }
    catch (err) { if (err.code !== 'EEXIST') { throw err; } }
    return file;
}
