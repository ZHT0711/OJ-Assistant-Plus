import axios from 'axios';
import * as cheerio from 'cheerio';
import { identify, luoguData, parseHtml, parseLuogu, PracticeProblem, problemKey, Target } from './problem';
import { TextDecoder } from 'util';
import { CookieJar } from 'tough-cookie';

// Anonymous client: never reuse the account adapters' cookies or authorization.
const client = axios.create({ timeout: 20000, maxContentLength: 5 * 1024 * 1024, maxRedirects: 5, headers: { 'user-agent': 'Mozilla/5.0 OJ-Assistant', accept: 'text/html,application/json' } });
async function fetchLuogu(url: string): Promise<any> {
    const jar = new CookieJar();
    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await client.get(url, { maxRedirects: 0, validateStatus: status => status < 500,
            headers: { 'x-lentille-request': 'content-only', cookie: jar.getCookieStringSync(url) } });
        for (const value of response.headers['set-cookie'] || []) {
            try { jar.setCookieSync(value, url); } catch { /* Ignore invalid CDN cookies. */ }
        }
        if (response.status === 200) { return response.data; }
        if (![301, 302, 303, 307, 308].includes(response.status)) { throw new Error(`洛谷请求失败 (${response.status})；该题可能不公开或需要验证`); }
    }
    throw new Error('洛谷站点验证未通过，请在浏览器打开或手动导入');
}
export async function fetchProblem(target: Target): Promise<PracticeProblem> {
    if (target.platform === '洛谷') {
        return parseLuogu(target, await fetchLuogu(target.url));
    }
    if (target.platform === 'Codeforces') {
        try { return parseHtml(target, (await client.get(target.url)).data); }
        catch {
            // elycode's public Luogu mirror strategy also covers CF anti-bot pages.
            const mirror = identify(`https://www.luogu.com.cn/problem/CF${target.contest}${target.id}`);
            const p = await fetchProblem(mirror);
            return { ...p, key: problemKey(target.url), url: target.url, submitUrl: target.submitUrl, platform: target.platform, group: `Codeforces · ${target.contest}` };
        }
    }
    const response = await client.get(target.url, { responseType: 'arraybuffer' });
    const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers['content-type'] || '')?.[1] || (/acm\.hdu\.edu\.cn/.test(target.url) ? 'gb18030' : 'utf-8');
    return parseHtml(target, new TextDecoder(charset).decode(response.data));
}

export async function collectionTargets(target: Target): Promise<Target[]> {
    if (!target.collection) { return [target]; }
    if (target.platform === 'Codeforces') {
        const response = await client.get('https://codeforces.com/api/contest.standings', { params: { contestId: target.contest } });
        if (response.data.status !== 'OK') { throw new Error(response.data.comment || '比赛题目暂不可访问'); }
        return response.data.result.problems.map((p: any) => identify(target.url + '/problem/' + p.index));
    }
    if (target.platform === '洛谷') {
        const data = luoguData(await fetchLuogu(target.url));
        const problems = data?.contestProblems || data?.problems || data?.contest?.problems;
        if (!Array.isArray(problems)) { throw new Error('该比赛暂不公开或需要账号权限，请在账号题库中使用'); }
        return problems.map((p: any) => identify('https://www.luogu.com.cn/problem/' + (p.problem?.pid || p.pid)));
    }
    const $ = cheerio.load((await client.get(target.url)).data);
    const links = new Set<string>();
    $('table a[href]').each((_, el) => {
        const url = new URL($(el).attr('href')!, target.url);
        if (url.hostname === 'atcoder.jp' && url.pathname.startsWith(`/contests/${target.contest}/tasks/`)) { links.add(url.toString()); }
    });
    if (!links.size) { throw new Error('没有找到公开的比赛题目，请检查比赛是否已开始或需要报名'); }
    return Array.from(links).map(identify);
}
