import axios from 'axios';
import { createHash, createHmac, randomBytes } from 'crypto';

/**
 * Multi-provider translation for problem statements (auto -> Chinese).
 *
 * Providers (all verified reachable from CN unless noted):
 *  - google    : translate.googleapis.com gtx endpoint, keyless  [primary]
 *  - tencent   : fanyi.qq.com web API with a saved Token (from a browser
 *                captcha exchange - see command "获取腾讯翻译Token"),
 *                or the official TMT API when secretId/secretKey configured.
 *  - youdao    : official OpenAPI only (appKey + appSecret); the old free
 *                web endpoints are dead.
 *  - mymemory  : keyless fallback (api.mymemory.translated.net)
 *
 * Config (.ojassistconfig.json):
 *   "translation": {
 *     "provider": "auto" | "google" | "tencent" | "youdao" | "mymemory",
 *     "tencentWebToken": "<from browser command>",
 *     "youdao":     { "appKey": "...", "appSecret": "..." },
 *     "tencent":    { "secretId": "...", "secretKey": "..." }
 *   }
 */
export interface TranslateOptions {
    provider?: string;
    tencentWebToken?: string;
    youdao?: { appKey?: string; appSecret?: string };
    tencent?: { secretId?: string; secretKey?: string };
    baidu?: { appId?: string; secretKey?: string };
    caiyun?: { token?: string };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';
const B = String.fromCharCode(92);

function sha256hex(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------- google gtx

async function googleTranslate(text: string): Promise<string> {
    const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: { client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: text },
        headers: { 'User-Agent': UA },
        timeout: 20000,
    });
    const segments = response.data?.[0];
    if (!Array.isArray(segments)) { throw new Error('gtx: bad response'); }
    return segments.map((s: any[]) => s[0]).join('');
}

// ---------------------------------------------------------------- mymemory

async function myMemoryTranslate(text: string): Promise<string> {
    const out: string[] = [];
    for (const chunk of text.match(/[\s\S]{1,480}/g) ?? [text]) {
        const response = await axios.get('https://api.mymemory.translated.net/get', {
            params: { q: chunk, langpair: 'en|zh-CN' },
            headers: { 'User-Agent': UA },
            timeout: 20000,
        });
        const translated = response.data?.responseData?.translatedText;
        out.push(translated ? String(translated) : chunk);
        await delay(200);
    }
    return out.join(' ');
}

// ------------------------------------------------- youdao official openapi

async function youdaoOfficial(text: string, appKey: string, appSecret: string): Promise<string> {
    const salt = randomBytes(8).toString('hex');
    const curtime = String(Math.floor(Date.now() / 1000));
    // v3 sign: sha256(appKey + truncate(q) + salt + curtime + appSecret)
    const q = text.length <= 20 ? text : text.slice(0, 10) + text.length + text.slice(-10);
    const sign = createHash('sha256').update(appKey + q + salt + curtime + appSecret).digest('hex');
    const response = await axios.post('https://openapi.youdao.com/api', null, {
        params: {
            q: text, from: 'auto', to: 'zh-CHS', appKey, salt,
            sign, signType: 'v3', curtime,
        },
        headers: { 'User-Agent': UA },
        timeout: 20000,
    });
    if (response.data?.errorCode !== '0') {
        throw new Error('youdao: ' + (response.data?.errorMsg ?? response.data?.errorCode ?? 'failed'));
    }
    const list = response.data?.translation ?? [];
    return Array.isArray(list) ? list.join('') : String(list);
}

// ---------------------------------------------- tencent official TMT (TC3)

async function tencentOfficial(
    text: string, secretId: string, secretKey: string,
): Promise<string> {
    const host = 'tmt.tencentcloudapi.com';
    const service = 'tmt';
    const action = 'Translate';
    const version = '2018-03-21';
    const region = 'ap-guangzhou';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify({ SourceText: text, Source: 'auto', Target: 'zh', ProjectId: 0 });

    const contentType = 'application/json; charset=utf-8';
    const signedHeaders = 'content-type;host;x-tc-action;x-tc-timestamp;x-tc-version';
    const canonicalRequest = [
        'POST', '/', '',
        'content-type:' + contentType,
        'host:' + host,
        'x-tc-action:' + action.toLowerCase(),
        'x-tc-timestamp:' + timestamp,
        'x-tc-version:' + version,
        '', signedHeaders, sha256hex(payload),
    ].join(String.fromCharCode(10));
    const stringToSign = [
        'TC3-HMAC-SHA256',
        String(timestamp),
        date + '/' + service + '/tc3-request',
        sha256hex(canonicalRequest),
    ].join(String.fromCharCode(10));
    const kDate = createHmac('sha256', 'TC3' + secretKey).update(date).digest();
    const kService = createHmac('sha256', kDate).update(service).digest();
    const kSigning = createHmac('sha256', kService).update('tc3_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authorization = [
        'TC3-HMAC-SHA256',
        'Credential=' + secretId + '/' + date + '/' + service + '/tc3-request',
        'SignedHeaders=' + signedHeaders,
        'Signature=' + signature,
    ].join(' ');

    const response = await axios.post('https://' + host, payload, {
        headers: {
            'Authorization': authorization,
            'Content-Type': contentType,
            'Host': host,
            'X-TC-Action': action,
            'X-TC-Version': version,
            'X-TC-Region': region,
            'X-TC-Timestamp': String(timestamp),
            'User-Agent': UA,
        },
        timeout: 20000,
    });
    const err = response.data?.Response?.Error;
    if (err) { throw new Error('tencent TMT: ' + err.Code + ' ' + err.Message); }
    return String(response.data?.Response?.TargetText ?? '');
}

// ------------------------------------------ tencent fanyi web (saved token)

async function tencentWeb(text: string, token: string): Promise<string> {
    // The web API translates line-oriented batches: keep \n structure.
    const response = await axios.post('https://api.fanyi.qq.com/api/v1/translate/text', {
        SourceTextList: text.split(String.fromCharCode(10)),
        Source: 'en',
        Target: 'zh',
        Token: token,
    }, {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': UA,
            'Origin': 'https://fanyi.qq.com',
            'Referer': 'https://fanyi.qq.com/',
        },
        timeout: 20000,
    });
    const code = response.data?.Code;
    if (code === 2000 || code === 2004) {
        throw new Error('tencent-web: token expired/invalid - run the "获取腾讯翻译Token" command');
    }
    if (code !== 0 && code !== undefined) {
        throw new Error('tencent-web: ' + (response.data?.Message ?? 'code ' + code));
    }
    const list = response.data?.Data?.TargetTextList;
    return Array.isArray(list) ? list.join(String.fromCharCode(10)) : String(list ?? '');
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ------------------------------------------------- baidu official transapi

async function baiduOfficial(text: string, appId: string, secretKey: string): Promise<string> {
    const salt = String(Math.floor(Math.random() * 1e8));
    const sign = createHash('md5').update(appId + text + salt + secretKey).digest('hex');
    const response = await axios.get('https://fanyi-api.baidu.com/transapi', {
        params: { q: text, from: 'auto', to: 'zh', appid: appId, salt, sign },
        headers: { 'User-Agent': UA },
        timeout: 20000,
    });
    const data = response.data;
    if (data?.error_code && data.error_code !== 52000) {
        throw new Error('baidu: ' + data.error_code + ' ' + (data.error_msg ?? data.errmsg ?? ''));
    }
    const first = Array.isArray(data?.data) ? data.data[0] : data?.data;
    if (first?.dst) { return String(first.dst); }
    if (Array.isArray(first?.paragraphs)) { return first.paragraphs.join(''); }
    if (data?.trans_result?.[0]?.dst) { return String(data.trans_result[0].dst); }
    throw new Error('baidu: unexpected response');
}

// ------------------------------------------------- caiyun xiaoyi (彩云小译)

async function caiyunTranslate(text: string, token: string): Promise<string> {
    const response = await axios.post('http://api.interpreter.caiyunai.com/v1/translator', {
        source: [text],
        trans_type: 'auto2zh',
        request_id: 'oj-assistant-' + Date.now(),
        os_type: 'web',
        media: 'text',
        dict: '',
        user: 'oj-assistant',
        url: '',
    }, {
        headers: {
            'Content-Type': 'application/json',
            'X-Token': token,
            'User-Agent': UA,
        },
        timeout: 20000,
        validateStatus: () => true,
    });
    const data = response.data;
    if (Array.isArray(data?.target) && data.target.length > 0) {
        return String(data.target[0]);
    }
    throw new Error('caiyun: ' + (data?.message ?? data?.msg ?? ('HTTP ' + response.status)));
}

// ------------------------------------------------------------- orchestration

async function translateVia(text: string, opts: TranslateOptions): Promise<string> {
    const provider = opts.provider ?? 'auto';
    const yd = opts.youdao;
    const tc = opts.tencent;
    const bd = opts.baidu;
    const cy = opts.caiyun;

    const tryOrder: Array<() => Promise<string>> = [];
    const push = (fn: () => Promise<string>) => { tryOrder.push(fn); };

    switch (provider) {
        case 'google':
            push(() => googleTranslate(text));
            break;
        case 'youdao':
            if (yd?.appKey && yd?.appSecret) {
                push(() => youdaoOfficial(text, yd.appKey!, yd.appSecret!));
            } else {
                throw new Error('有道翻译需要配置 translation.youdao.appKey/appSecret（有道智云开放平台免费注册）');
            }
            break;
        case 'tencent':
            // fanyi.qq.com web token first (fields verified live); official
            // TMT credentials as an additional attempt when configured.
            if (opts.tencentWebToken) {
                push(() => tencentWeb(text, opts.tencentWebToken!));
            }
            if (tc?.secretId && tc?.secretKey) {
                push(() => tencentOfficial(text, tc.secretId!, tc.secretKey!));
            }
            if (tryOrder.length === 0) {
                throw new Error('腾讯翻译：请先运行命令“获取腾讯翻译Token”，或配置 translation.tencent.secretId/secretKey');
            }
            break;
        case 'baidu':
            if (bd?.appId && bd?.secretKey) {
                push(() => baiduOfficial(text, bd.appId!, bd.secretKey!));
            } else {
                throw new Error('百度翻译需要配置 translation.baidu.appId/secretKey（百度翻译开放平台免费注册）');
            }
            break;
        case 'caiyun':
            if (cy?.token) {
                push(() => caiyunTranslate(text, cy.token!));
            } else {
                throw new Error('彩云小译需要配置 translation.caiyun.token（彩云译API免费申请）');
            }
            break;
        case 'mymemory':
            push(() => myMemoryTranslate(text));
            break;
        default: // auto: configured domestic channels first, then google, then mymemory
            if (bd?.appId && bd?.secretKey) { push(() => baiduOfficial(text, bd.appId!, bd.secretKey!)); }
            if (opts.tencentWebToken) { push(() => tencentWeb(text, opts.tencentWebToken!)); }
            if (yd?.appKey && yd?.appSecret) { push(() => youdaoOfficial(text, yd.appKey!, yd.appSecret!)); }
            if (cy?.token) { push(() => caiyunTranslate(text, cy.token!)); }
            if (tc?.secretId && tc?.secretKey) { push(() => tencentOfficial(text, tc.secretId!, tc.secretKey!)); }
            push(() => googleTranslate(text));
            push(() => myMemoryTranslate(text));
            break;
    }

    let lastError: unknown;
    for (const attempt of tryOrder) {
        try { return await attempt(); }
        catch (err) { lastError = err; }
    }
    throw lastError instanceof Error ? lastError : new Error('所有翻译通道均失败');
}

/**
 * Translate the TEXT nodes of an HTML fragment to Chinese.
 * <pre>/<code> regions are stashed untouched; tags are preserved.
 */
export async function translateHtmlToChinese(
    html: string,
    opts: TranslateOptions = {},
): Promise<string> {
    if (!html) { return ''; }

    // 1. stash verbatim regions
    const stash: string[] = [];
    const preRe = new RegExp('<(pre|code)' + B + 'b[' + B + 's' + B + 'S]*?<' + B + '/' + B + '1>', 'gi');
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

    // 3. translate with small concurrency
    const CONCURRENCY = 3;
    let cursor = 0;
    let failures = 0;
    let lastError: unknown;
    async function worker(): Promise<void> {
        while (cursor < targets.length) {
            const idx = targets[cursor++];
            try {
                parts[idx] = await translateVia(parts[idx], opts);
            } catch (err) {
                failures += 1;
                lastError = err;
            }
            await delay(120);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    // Misconfiguration / all channels down: surface the error instead of
    // silently returning the untranslated original text.
    if (targets.length > 0 && failures >= targets.length && lastError) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    // 4. restore verbatim regions
    let result = parts.join('');
    result = result.replace(new RegExp('%%VERBATIM' + B + 'd+%%', 'g'), (m) => {
        const idx = Number(m.match(new RegExp(B + 'd+'))![0]);
        return stash[idx] ?? m;
    });
    return result;
}
