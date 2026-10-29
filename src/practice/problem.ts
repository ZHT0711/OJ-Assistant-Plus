import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import { markdownToHtml } from '../utils/markdown';

export interface Sample { input: string; output: string; }
export interface PracticeProblem {
    version: 1;
    key: string;
    url: string;
    submitUrl: string;
    platform: string;
    title: string;
    group: string;
    statement: string;
    samples: Sample[];
}
export interface Target {
    url: string; platform: string; id: string; contest?: string; collection?: boolean; submitUrl: string;
}

export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function normalizeUrl(raw: string): URL {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) && !/^https?:\/\//i.test(raw.trim())) { throw new Error('仅支持 HTTP(S) 链接'); }
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : 'https://' + raw.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) { throw new Error('请输入不含账号密码的 HTTP(S) 题目或比赛链接'); }
    url.hash = '';
    return url;
}

export function identify(raw: string): Target {
    const url = normalizeUrl(raw);
    const host = url.hostname.toLowerCase();
    const p = url.pathname.replace(/\/+$/, '');
    let m: RegExpMatchArray | null;
    if (/^(?:www\.|m1\.|m2\.)?codeforces\.com$/.test(host)) {
        m = p.match(/^\/(contest|gym)\/(\d+)(?:\/problem\/([A-Za-z]\d?))?$/);
        const ps = p.match(/^\/problemset\/problem\/(\d+)\/([A-Za-z]\d?)$/);
        if (!m && !ps) { throw new Error('请使用 Codeforces 比赛或题目链接'); }
        const contest = ps ? ps[1] : m![2];
        const id = (ps ? ps[2] : m![3] || '').toUpperCase();
        const type = m?.[1] === 'gym' ? 'gym' : 'contest';
        const canonical = `https://codeforces.com/${type}/${contest}`;
        return { url: canonical + (id ? '/problem/' + id : ''), platform: 'Codeforces', contest, id, collection: !id, submitUrl: canonical + '/submit' + (id ? '?problemIndex=' + id : '') };
    }
    if (/^(?:www\.)?luogu\.(?:com\.cn|org)$/.test(host)) {
        m = p.match(/^\/(problem|contest)\/([A-Za-z0-9_]+)$/);
        if (!m) { throw new Error('请使用洛谷题目或比赛链接'); }
        const id = m[1] === 'problem' ? m[2].toUpperCase() : m[2];
        const canonical = `https://www.luogu.com.cn/${m[1]}/${id}`;
        return { url: canonical, platform: '洛谷', id, collection: m[1] === 'contest', submitUrl: canonical + '#submit' };
    }
    if (/^(?:www\.)?atcoder\.jp$/.test(host)) {
        m = p.match(/^\/contests\/([A-Za-z0-9_-]+)(?:\/tasks(?:\/([A-Za-z0-9_-]+))?)?$/);
        if (!m) { throw new Error('请使用 AtCoder 比赛或任务链接'); }
        const base = 'https://atcoder.jp/contests/' + m[1];
        return { url: base + (m[2] ? '/tasks/' + m[2] : '/tasks') + '?lang=en', platform: 'AtCoder', contest: m[1], id: m[2] || '', collection: !m[2], submitUrl: base + '/submit' + (m[2] ? '?taskScreenName=' + m[2] : '') };
    }
    url.searchParams.delete('utm_source');
    return { url: url.toString(), platform: host, id: p, submitUrl: url.toString() };
}

/** Keep statement markup inert, including persisted/manual statements. */
export function sanitizeHtml(html: string, base: string): string {
    const $ = cheerio.load(html, { decodeEntities: false });
    $('script,style,iframe,object,embed,form,input,button,textarea,select,link,meta,base,svg,math').remove();
    const allowed = new Set('html body div span p br pre code h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tr th td blockquote strong b em i u s sub sup hr a img section article dl dt dd'.split(' '));
    $('var').each((_, el) => { $(el).replaceWith(escapeHtml('\\(' + $(el).text() + '\\)')); });
    $('*').each((_, el: any) => {
        if (!allowed.has(el.tagName)) { $(el).replaceWith($(el).contents()); return; }
        for (const attr of Object.keys(el.attribs || {})) {
            const value = el.attribs[attr];
            if ((attr === 'href' && el.tagName === 'a') || (attr === 'src' && el.tagName === 'img')) {
                try {
                    const url = new URL(value, base);
                    if (!/^https?:$/.test(url.protocol)) { $(el).removeAttr(attr); }
                    else { $(el).attr(attr, url.toString()); }
                } catch { $(el).removeAttr(attr); }
            } else if (!['colspan', 'rowspan', 'alt', 'title'].includes(attr)) { $(el).removeAttr(attr); }
        }
    });
    return $('body').html() || '';
}

export function makeProblem(target: Target, title: string, statement: string, samples: Sample[], group?: string): PracticeProblem {
    if (!title.trim() || !statement.trim()) { throw new Error('页面未包含可识别的公开题面，可能需要登录或遇到了站点验证；可改用手动导入'); }
    return {
        version: 1, key: problemKey(target.url),
        url: target.url, submitUrl: target.submitUrl, platform: target.platform,
        title: title.trim(), group: group || [target.platform, target.contest].filter(Boolean).join(' · '),
        statement: sanitizeHtml(statement, target.url), samples,
    };
}

export function problemKey(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 20);
}

export function luoguData(raw: any): any {
    if (typeof raw !== 'string') { return raw?.data || raw?.currentData || raw; }
    const $ = cheerio.load(raw);
    const context = $('script#lentille-context').html();
    if (context) { return luoguData(JSON.parse(context)); }
    const encoded = raw.match(/JSON\.parse\(decodeURIComponent\("([^"\n]+)"\)\)/);
    if (encoded) { return luoguData(JSON.parse(decodeURIComponent(encoded[1]))); }
    try { return luoguData(JSON.parse(raw)); } catch { throw new Error('洛谷返回了验证页面或非公开题目，请在浏览器打开或手动导入'); }
}

export function parseLuogu(target: Target, raw: any): PracticeProblem {
    const data = luoguData(raw);
    const p = data?.problem;
    if (!p) { throw new Error('没有找到洛谷题目数据'); }
    const c = p.content || {};
    const text = [c.description || p.description, c.formatI || p.inputFormat, c.formatO || p.outputFormat, c.hint || p.hint];
    const labels = ['题目描述', '输入格式', '输出格式', '提示'];
    const statement = text.map((s, i) => s ? `<h2>${labels[i]}</h2>${markdownToHtml(s)}` : '').join('');
    return makeProblem(target, p.name || p.title || target.id, statement, (p.samples || []).map((s: string[]) => ({ input: s[0] || '', output: s[1] || '' })));
}

function preText($: any, el: any): string {
    const clone = $(el).clone();
    clone.find('br').replaceWith('\n');
    // Codeforces represents sample lines as adjacent divs.
    clone.find('div').each((_: number, d: any) => { $(d).append('\n'); });
    return clone.text().replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/^\n|\n$/g, '');
}

export function parseHtml(target: Target, html: string): PracticeProblem {
    const $ = cheerio.load(html);
    let statement: string | null = null;
    let title = '';
    const samples: Sample[] = [];
    if (target.platform === 'Codeforces') {
        const root = $('.problem-statement').first();
        title = root.find('.title').first().text();
        const inputs = root.find('.sample-test .input pre').toArray();
        const outputs = root.find('.sample-test .output pre').toArray();
        inputs.forEach((el, i) => samples.push({ input: preText($, el), output: outputs[i] ? preText($, outputs[i]) : '' }));
        root.find('.sample-test').remove();
        statement = root.html();
    } else if (target.platform === 'AtCoder') {
        const root = $('#task-statement .lang-en').first().length ? $('#task-statement .lang-en').first() : $('#task-statement').first();
        title = $('.h2').first().clone().children().remove().end().text().trim() || $('title').text();
        const inputs: string[] = [], outputs: string[] = [];
        root.find('h3').each((_, heading) => {
            const label = $(heading).text();
            const siblings = $(heading).nextAll();
            const pre = siblings.filter('pre').first().length ? siblings.filter('pre').first() : siblings.find('pre').first();
            if (/Sample Input|入力例/i.test(label)) { inputs.push(preText($, pre)); }
            if (/Sample Output|出力例/i.test(label)) { outputs.push(preText($, pre)); }
        });
        inputs.forEach((input, i) => samples.push({ input, output: outputs[i] || '' }));
        statement = root.html();
    } else if (/^(?:acm\.)?hdu\.edu\.cn$/.test(new URL(target.url).hostname)) {
        title = $('h1').first().text();
        const sections = $('.panel_content');
        statement = sections.toArray().map((el, i) => `<h2>${escapeHtml($(el).prev().text() || ['描述', '输入', '输出', '样例输入', '样例输出', '来源'][i] || '')}</h2>${$(el).html()}`).join('');
        const input = sections.eq(3), output = sections.eq(4);
        if (input.length && output.length) { samples.push({ input: preText($, input), output: preText($, output) }); }
    } else {
        // Conservative structural fallback; do not mistake an entire login page for a problem.
        const root = $('.problem-statement, #task-statement, #problem-content, .problem-content, .problem-description, article.problem').first();
        title = $('h1, .problem-title').first().text() || $('title').text();
        statement = root.html();
        const inputs = root.find('.sample-input pre, pre.sample-input, .input pre').toArray();
        const outputs = root.find('.sample-output pre, pre.sample-output, .output pre').toArray();
        inputs.forEach((el, i) => samples.push({ input: preText($, el), output: outputs[i] ? preText($, outputs[i]) : '' }));
    }
    return makeProblem(target, title, statement || '', samples);
}

/** Competitive Companion JSON and the editable manual template share these fields. */
export function parseManual(raw: any): PracticeProblem {
    const target = identify(String(raw.url || ''));
    if (target.collection) { throw new Error('手动导入请填写单题链接'); }
    const tests = raw.tests || raw.samples || [];
    if (!Array.isArray(tests) || tests.some((s: any) => typeof s.input !== 'string' || typeof s.output !== 'string')) { throw new Error('tests 应为包含 input/output 字符串的数组'); }
    return makeProblem(target, String(raw.name || raw.title || ''), markdownToHtml(raw.statement || '手动导入题目，请在原题网页查看题面。'), tests, typeof raw.group === 'string' ? raw.group : undefined);
}
