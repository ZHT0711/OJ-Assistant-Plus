/**
 * Minimal Markdown -> HTML converter for OJ problem statements.
 *
 * The webview renders `problem.content.*` as raw HTML, so Markdown sources
 * (Luogu etc.) have to be converted on the Node side - the webview CSP does not
 * allow loading a client side Markdown library.
 *
 * Scope: headings, fenced code, inline code, bold/italic, links, images,
 * lists, blockquotes, horizontal rules, simple tables, paragraphs with
 * hard line breaks. Everything else is passed through as text.
 */

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function inline(text: string): string {
    let out = text;
    // inline code first so its content is not processed further.
    out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}">`);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<em>$1</em>');
    return out;
}

export function markdownToHtml(markdown: string | undefined | null): string {
    if (markdown === undefined || markdown === null) { return ''; }
    const source = escapeHtml(String(markdown)).replace(/\r\n?/g, '\n');
    const lines = source.split('\n');
    const html: string[] = [];
    let i = 0;
    let listMode: 'ul' | 'ol' | undefined;

    const closeList = () => {
        if (listMode) {
            html.push(listMode === 'ul' ? '</ul>' : '</ol>');
            listMode = undefined;
        }
    };

    while (i < lines.length) {
        const line = lines[i];

        // fenced code block
        const fence = line.match(/^\s*(```+|~~~+)\s*$/);
        if (fence) {
            closeList();
            const marker = fence[1][0];
            const lang = line.trim().slice(marker.length).trim();
            const code: string[] = [];
            i++;
            while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
                code.push(lines[i]);
                i++;
            }
            i++; // skip closing fence
            html.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${code.join('\n')}</code></pre>`);
            continue;
        }

        // table: header row + separator row
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            closeList();
            const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            html.push('<table><thead><tr>' + cells(line).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
            i += 2;
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
                html.push('<tr>' + cells(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
                i++;
            }
            html.push('</tbody></table>');
            continue;
        }

        // headings
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            closeList();
            const level = heading[1].length;
            html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
            i++;
            continue;
        }

        // horizontal rule
        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
            closeList();
            html.push('<hr>');
            i++;
            continue;
        }

        // unordered list
        const ulItem = line.match(/^\s*[-*+]\s+(.*)$/);
        if (ulItem) {
            if (listMode !== 'ul') { closeList(); html.push('<ul>'); listMode = 'ul'; }
            html.push(`<li>${inline(ulItem[1])}</li>`);
            i++;
            continue;
        }

        // ordered list
        const olItem = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (olItem) {
            if (listMode !== 'ol') { closeList(); html.push('<ol>'); listMode = 'ol'; }
            html.push(`<li>${inline(olItem[1])}</li>`);
            i++;
            continue;
        }

        // blockquote
        if (/^\s*&gt;\s?/.test(line)) {
            closeList();
            const quote: string[] = [];
            while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
                quote.push(lines[i].replace(/^\s*&gt;\s?/, ''));
                i++;
            }
            html.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`);
            continue;
        }

        // blank line
        if (line.trim() === '') {
            closeList();
            i++;
            continue;
        }

        // paragraph: collect until blank line / next block element
        closeList();
        const para: string[] = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== ''
            && !/^(#{1,6})\s/.test(lines[i])
            && !/^\s*(```+|~~~+)/.test(lines[i])
            && !/^\s*[-*+]\s+/.test(lines[i])
            && !/^\s*\d+[.)]\s+/.test(lines[i])
            && !/^\s*&gt;\s?/.test(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        html.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    closeList();
    return html.join('\n');
}

// ---------------------------------------------------------------------------
// LaTeX pre-rendering (KaTeX, bundled in assets/katex - fully offline)
// ---------------------------------------------------------------------------

import * as katex from 'katex';

/**
 * Render every TeX construct in an HTML fragment to KaTeX markup:
 *   $...$ (inline), $$...$$ / \[..\] (display), \(..\) (inline), plus the
 *   legacy Codeforces $$$$$ chains. Content inside <pre>/<code> is left
 *   untouched so sample data that happens to contain `$` survives.
 */
export function renderLatex(html: string | undefined | null): string {
    if (html === undefined || html === null || html === '') { return ''; }
    let out = String(html);

    // 1. Protect verbatim regions.
    const stash: string[] = [];
    const keep = (text: string) => { stash.push(text); return '#' + (stash.length - 1) + '#'; };
    out = out.replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, m => keep(m));

    // 2. Collect math spans (longest delimiters first) into placeholders.
    const rules: Array<[RegExp, boolean]> = [
        [/\$\$\$\$\$\$(.+?)\$\$\$\$\$\$/gs, true],
        [/\$\$\$(.+?)\$\$\$/gs, true],
        [/\$\$([\s\S]+?)\$\$/gs, true],
        [/\\\(([\s\S]+?)\\\)/gs, false],
        [/\\\[([\s\S]+?)\\\]/gs, true],
        [/(?<![\w$\\])\$([^$\n]+?)\$(?![\w$])/gs, false],
    ];
    for (const [pattern, displayMode] of rules) {
        out = out.replace(pattern, (whole: string, tex: string) => {
            try {
                const rendered = katex.renderToString(tex.trim(), {
                    displayMode,
                    throwOnError: false,
                    output: 'htmlAndMathml',
                });
                stash.push(rendered);
                return '#' + (stash.length - 1) + '#';
            } catch {
                return whole;
            }
        });
    }

    // 3. Restore stashed regions (verbatim first, then rendered math).
    out = out.replace(/#(\d+)#/g, (_m, i: string) => stash[Number(i)] ?? _m);
    out = out.replace(/#(\d+)#/g, (_m, i: string) => stash[Number(i)] ?? _m);
    return out;
}
