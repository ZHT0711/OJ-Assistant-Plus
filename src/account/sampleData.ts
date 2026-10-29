import * as cheerio from 'cheerio';
import { Sample } from '../practice/problem';
import { adapterFor } from '../backend/platforms';

export function sampleText(value: string, html: boolean): string {
    if (!html) { return value.replace(/\u00a0/g, ' '); }
    const $ = cheerio.load('<div id="sample">' + value + '</div>');
    const root = $('#sample');
    root.find('br').replaceWith('\n');
    root.find('div,p').each((_, node) => { $(node).append('\n'); });
    return root.text().replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/^\n|\n$/g, '');
}
export function problemSamples(backend: string, content: { sampleInput: string[]; sampleOutput: string[] }): Sample[] {
    const html = adapterFor(backend)?.sampleHtml ?? true;
    return content.sampleInput.map((input, i) => ({ input: sampleText(String(input || ''), html), output: sampleText(String(content.sampleOutput[i] || ''), html) }));
}
export function validSamples(value: any): value is Sample[] {
    return Array.isArray(value) && value.length <= 100 && value.every(s => s && typeof s.input === 'string' && typeof s.output === 'string' && s.input.length + s.output.length <= 2 * 1024 * 1024);
}
