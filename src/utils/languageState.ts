/**
 * Shared "which language am I solving in" state.
 *
 * Set from the OJ Assistant panel (language row) or the submit-time picker;
 * read when creating solution files (extension + template) and when submitting
 * (skips the picker when the choice was made explicitly in the panel).
 */
export interface LanguageChoice {
    value: string | number;
    label: string;
}

let preferred: LanguageChoice | undefined;

export function getPreferredLanguage(): LanguageChoice | undefined {
    return preferred;
}

export function setPreferredLanguage(choice: LanguageChoice | undefined): void {
    preferred = choice;
}

/** Resolve a persisted config value (preferredLanguage) via the platform list. */
export function resolvePreferred(
    raw: string | number | undefined,
    available: Array<{ value: string | number; label: string }> | undefined,
): LanguageChoice | undefined {
    if (raw === undefined || raw === null || !available) { return undefined; }
    const hit = available.find(l => String(l.value) === String(raw));
    if (hit) { return { value: hit.value, label: hit.label }; }
    return undefined;
}

/** Map a language choice to a source-file extension. */
export function languageFileExt(choice: LanguageChoice | undefined): string {
    return extensionForLanguage(choice) || 'cpp';
}

export function extensionForLanguage(choice: LanguageChoice | undefined): string | undefined {
    if (!choice) { return undefined; }
    const value = String(choice.value).toLowerCase();
    const label = String(choice.label).toLowerCase();
    const byValue: { [k: string]: string } = {
        'c': 'c', 'gcc': 'c', 'cpp': 'cpp', 'c++': 'cpp', 'g++': 'cpp', 'cc': 'cpp',
        'java': 'java', 'python': 'py', 'python3': 'py', 'py': 'py', 'py3': 'py',
        'javascript': 'js', 'node': 'js', 'typescript': 'ts', 'golang': 'go', 'go': 'go', 'rs': 'rs', 'cs': 'cs',
        'csharp': 'cs', 'c#': 'cs', 'kotlin': 'kt', 'swift': 'swift', 'rust': 'rs',
        'ruby': 'rb', 'php': 'php', 'scala': 'scala', 'pascal': 'pas', 'txt': 'txt',
    };
    if (byValue[value]) { return byValue[value]; }
    const abbreviation = /^(cpp|cc|cxx|c|cs|py|py2|py3|js|ts|go|rs|java|txt)(?=\s|\(|$)/.exec(label.trim())?.[1];
    if (abbreviation) {
        const family: { [key: string]: string } = { cc: 'cpp', cxx: 'cpp', py2: 'py', py3: 'py' };
        return family[abbreviation] || abbreviation;
    }
    if (label.includes('python')) { return 'py'; }
    if (label.includes('c++') || label.includes('g++') || /\bcpp\b/.test(label)) { return 'cpp'; }
    if (/^(?:gnu\s*)?c(?:\s|$|\d)|\bgcc\b/.test(label)) { return 'c'; }
    if (label.includes('c#')) { return 'cs'; }
    if (label.includes('javascript') || label.includes('node')) { return 'js'; }
    if (label.includes('typescript')) { return 'ts'; }
    if (label.includes('java')) { return 'java'; }
    if (label.includes('kotlin')) { return 'kt'; }
    if (label.includes('swift')) { return 'swift'; }
    if (label.includes('rust')) { return 'rs'; }
    if (label.includes('ruby')) { return 'rb'; }
    if (label.includes('php')) { return 'php'; }
    if (label.includes('scala')) { return 'scala'; }
    if (label.includes('pascal')) { return 'pas'; }
    if (label.includes('go')) { return 'go'; }
    if (label.includes('script')) { return 'js'; }
    if (value === '1' && label.includes('g++')) { return 'cpp'; }
    return undefined;
}
