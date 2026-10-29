import { promises as fs, readFileSync } from 'fs';
import * as path from 'path';
import { PracticeProblem } from './problem';
import { languageForSource } from './languages';

export const PRACTICE_DIR = '.oj-assistant/practice';
export function problemDir(root: string, key: string): string {
    if (!/^[a-f0-9]{20}$/.test(key)) { throw new Error('无效的本地题目编号'); }
    return path.join(root, PRACTICE_DIR, key);
}
export function isPracticeSource(root: string, file: string): boolean {
    const relative = path.relative(path.join(root, PRACTICE_DIR), file);
    return /^[a-f0-9]{20}[\\/]main\.[a-z]+$/.test(relative) && !!languageForSource(relative);
}
export function readPractice(root: string, file: string): PracticeProblem | undefined {
    if (!isPracticeSource(root, file)) { return undefined; }
    try { return JSON.parse(readFileSync(path.join(path.dirname(file), 'problem.json'), 'utf8')); }
    catch { return undefined; }
}
export async function saveProblem(root: string, p: PracticeProblem, replace = false): Promise<boolean> {
    const dir = problemDir(root, p.key);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'problem.json');
    if (!replace) {
        try { await fs.writeFile(file, JSON.stringify(p, null, 2), { encoding: 'utf8', flag: 'wx' }); return true; }
        catch (err) {
            if (err.code === 'EEXIST') { await fs.unlink(path.join(dir, '.removed')).catch(() => undefined); return false; }
            throw err;
        }
    }
    const temp = file + '.tmp';
    await fs.writeFile(temp, JSON.stringify(p, null, 2), 'utf8');
    await fs.rename(temp, file);
    return true;
}
export async function listProblems(root: string): Promise<PracticeProblem[]> {
    const dir = path.join(root, PRACTICE_DIR);
    let keys: string[];
    try { keys = await fs.readdir(dir); } catch (err) { if (err.code === 'ENOENT') { return []; } throw err; }
    const problems: PracticeProblem[] = [];
    for (const key of keys.filter(k => /^[a-f0-9]{20}$/.test(k))) {
        try {
            if (await fs.stat(path.join(dir, key, '.removed')).then(() => true, () => false)) { continue; }
            const p = JSON.parse(await fs.readFile(path.join(dir, key, 'problem.json'), 'utf8'));
            if (p.version === 1 && p.key === key && typeof p.title === 'string' && Array.isArray(p.samples)) { problems.push(p); }
        } catch { /* A broken individual cache must not hide the rest of the collection. */ }
    }
    return problems;
}

export async function removeProblem(root: string, key: string): Promise<void> {
    await fs.writeFile(path.join(problemDir(root, key), '.removed'), '');
}
