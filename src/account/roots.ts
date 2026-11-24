import * as path from 'path';
import { existsSync } from 'fs';

export function containsPath(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

/** A nested config owns its files; never search above the opened workspace. */
export function nearestAccountRoot(file: string, workspaceRoot: string): string {
    let directory = path.dirname(file);
    while (containsPath(workspaceRoot, directory)) {
        if (existsSync(path.join(directory, '.ojassistconfig.json'))) { return directory; }
        const parent = path.dirname(directory);
        if (parent === directory) { break; }
        directory = parent;
    }
    return workspaceRoot;
}
