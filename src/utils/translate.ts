import axios from 'axios';

/**
 * Free English -> Chinese translation for problem statements.
 *
 * Primary: Google gtx endpoint (no key, tested reachable) - one request per
 * text segment, order-preserving.
 * Fallback: MyMemory (no key, 480-char chunks) when gtx is unreachable.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';

async function gtx(text: string): Promise<string> {
    const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: { client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: text },
        headers: { 'User-Agent': UA },
        timeout: 20000,
    });
    const segments = response.data?.[0];
    if (!Array.isArray(segments)) { throw new Error('gtx: bad response'); }
    return segments.map((s: any[]) => s[0]).join('');
}

async function myMemory(text: string): Promise<string> {
    const response = await axios.get('https://api.mymemory.translated.net/get', {
        params: { q: text.slice(0, 480), langpair: 'en|zh-CN' },
        headers: { 'User-Agent': UA },
        timeout: 20000,
    });
    const translated = response.data?.responseData?.translatedText;
    if (!translated) { throw new Error('mymemory: empty'); }
    return String(translated);
}

async function translateText(text: string): Promise<string> {
    try { return await gtx(text); }
    catch { return await myMemory(text); }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Translate the TEXT nodes of an HTML fragment to Chinese.
 * <pre>/<code> regions are stashed untouched (never translate code/samples);
 * tags are preserved; segments without latin words pass through.
 */
export async function translateHtmlToChinese(html: string): Promise<string> {
    if (!html) { return ''; }

    // 1. stash verbatim regions
    const stash: string[] = [];
    const preRe = new RegExp('<(pre|code)\\b[\\s\\S]*?</\\1>', 'gi');
    let out = html.replace(preRe, (m) => {
        stash.push(m);
        return '%%VERBATIM' + (stash.length - 1) + '%%';
    });

    // 2. split into tags and text nodes
    const parts = out.split(new RegExp('(<[^>]+>)'));
    const targets: number[] = [];
    for (let i = 0; i < parts.length; i += 2) {
        const text = parts[i];
        if (/[A-Za-z]{3,}/.test(text) && !/^%%VERBATIM\d+%%$/.test(text.trim())) {
            targets.push(i);
        }
    }

    // 3. translate sequentially-ish with small concurrency
    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < targets.length) {
            const idx = targets[cursor++];
            try {
                parts[idx] = await translateText(parts[idx]);
            } catch { /* keep original on failure */ }
            await delay(120);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // 4. restore verbatim regions
    let result = parts.join('');
    result = result.replace(new RegExp('%%VERBATIM\\d+%%', 'g'), (m) => {
        const idx = Number(m.match(/\d+/)![0]);
        return stash[idx] ?? m;
    });
    return result;
}
