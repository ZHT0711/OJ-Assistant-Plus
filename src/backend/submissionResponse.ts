import * as cheerio from 'cheerio';
import { TextDecoder } from 'util';

export type SubmissionRestriction = 'cooldown' | 'captcha' | 'duplicate';

/** The platform explicitly refused this upload. A transport error is ambiguous. */
export class SubmissionRejected extends Error {
    constructor(public kind: SubmissionRestriction, message: string, public retryAt?: number) {
        super(message);
    }
}

interface SubmissionResponse {
    status?: number;
    headers?: { [key: string]: any };
    data?: any;
}

function responseMessages(data: any, depth = 0, errorFields = false): string[] {
    if (depth > 5 || data == null) { return []; }
    if (typeof data === 'string') { return [data]; }
    if (Array.isArray(data)) { return data.flatMap(value => responseMessages(value, depth + 1, errorFields)); }
    if (typeof data !== 'object') { return []; }
    return Object.keys(data).filter(key => errorFields || /^(?:error|errors|message|msg|detail|details|non_field_errors|data)$/i.test(key))
        .flatMap(key => responseMessages(data[key], depth + 1, errorFields || /^(?:error|errors)$/i.test(key)));
}

function retryDelay(response: SubmissionResponse, message: string, now: number): number | undefined {
    const headers = response.headers || {};
    const header = headers['retry-after'] ?? headers['Retry-After'];
    if (header !== undefined) {
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) { return seconds * 1000; }
        const date = Date.parse(String(header));
        if (Number.isFinite(date)) { return Math.max(0, date - now); }
    }
    const data = response.data;
    const seconds = data?.retry_after ?? data?.retryAfter ?? data?.data?.retry_after ?? data?.data?.retryAfter;
    if (seconds !== undefined && Number.isFinite(Number(seconds)) && Number(seconds) >= 0) { return Number(seconds) * 1000; }
    const duration = message.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|秒|minutes?|mins?|分钟)/i);
    if (duration) { return Number(duration[1]) * (/^(?:m|分)/i.test(duration[2]) ? 60000 : 1000); }
    return undefined;
}

/** Inspect only submit responses and submit forms, excluding echoed source and scripts. */
export function checkSubmissionResponse(response: SubmissionResponse, now = Date.now()): void {
    let data = response.data;
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        const charset = String(response.headers?.['content-type'] || '').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
        try { data = new TextDecoder(charset).decode(new Uint8Array(data)); }
        catch { data = Buffer.from(data).toString('utf8'); }
    }
    let message = responseMessages(data).join('\n');
    let captchaForm = false;
    let challengePage = false;
    if (/<[a-z][\s\S]*>/i.test(message)) {
        const $ = cheerio.load(message);
        const alerts = $('script').toArray().map(el => $(el).html()?.match(/alert\s*\(\s*['"]([^'"]+)['"]/i)?.[1] || '');
        challengePage = $('script[src*="challenge-platform"], script[src*="alicfw"]').length > 0;
        $('script, style, textarea, pre, code, [hidden], [aria-hidden="true"]').remove();
        captchaForm = $('input[name]').toArray().some(el =>
            $(el).attr('disabled') === undefined && $(el).attr('type') !== 'hidden' && /captcha|verify_?code|verification_?code/i.test($(el).attr('name') || '')) ||
            $('.g-recaptcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').length > 0;
        message = [$.root().text(), ...alerts].join('\n');
    }
    const captchaRequired = data?.captcha_required === true || data?.captchaRequired === true || data?.needCaptcha === true;
    const cooldown = /too (?:many|frequent|fast)|submit.{0,30}(?:too fast|too frequently)|rate[ _-]?limit|cooldown|throttl|提交.{0,12}(?:频繁|过快|间隔)|(?:稍后|等待|请等|请在).{0,20}(?:重试|再试|提交)|(?:seconds?|秒|分钟).{0,12}(?:后|before|between).{0,12}(?:提交|submit|重试)|wait.{0,30}(?:seconds?|minutes?|submi)/i.test(message);
    const captcha = captchaForm || challengePage || captchaRequired || /captcha|验证码|人机验证|安全验证|verify (?:that )?you are human|human verification|challenge-platform|alicfw|geetest/i.test(message);
    if (response.status === 429 || cooldown) {
        // Platforms that omit a duration get a single conservative 60-second wait.
        const delay = retryDelay(response, message, now) ?? 60000;
        throw new SubmissionRejected('cooldown', `平台限制提交频率，请等待 ${Math.ceil(delay / 1000)} 秒后手动提交。`, now + delay);
    }
    if (captcha) { throw new SubmissionRejected('captcha', '平台要求验证码或安全验证，请复制代码并打开原站，在浏览器中完成验证和提交。'); }
    if (/重复提交|已经提交过.{0,12}(?:代码|程序)|same (?:source|code)|duplicate (?:code|submission)|already submitted.{0,30}(?:code|solution)/i.test(message)) {
        throw new SubmissionRejected('duplicate', '平台拒绝了重复代码，请先查看原站提交记录。');
    }
}

/** Preserve raw HTTP rejection information even when Axios rejects its status. */
export async function submissionRequest<T extends SubmissionResponse>(operation: Promise<T>): Promise<T> {
    let response: T;
    try { response = await operation; }
    catch (error) {
        if (error?.response) { checkSubmissionResponse(error.response); }
        throw error;
    }
    checkSubmissionResponse(response);
    return response;
}
