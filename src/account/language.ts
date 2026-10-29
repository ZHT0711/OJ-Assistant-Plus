import { extensionForLanguage, LanguageChoice } from '../utils/languageState';

export function sourceExtension(ext: string): string {
    const aliases: { [key: string]: string } = { cc: 'cpp', cxx: 'cpp', py2: 'py', py3: 'py', python: 'py', python3: 'py', node: 'js', golang: 'go', rust: 'rs' };
    return aliases[ext.toLowerCase()] || ext.toLowerCase();
}
export function matchLanguages(ext: string, available: LanguageChoice[], remembered?: LanguageChoice, preferred?: LanguageChoice, configured?: string | number) {
    const family = sourceExtension(ext);
    const choices = available.filter(language => extensionForLanguage(language) === family);
    const hit = (value: string | number | undefined) => choices.find(l => value !== undefined && String(l.value) === String(value));
    return { choices, selected: hit(remembered?.value) || hit(configured) || hit(preferred?.value) || (choices.length === 1 ? choices[0] : undefined) };
}
