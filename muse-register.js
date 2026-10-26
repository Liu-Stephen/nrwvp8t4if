'use strict';

/**
 * muse.ai 注册链路侦察脚本（第一版）
 *
 * 只做：打开站点 → dump 首页结构 → 尝试点击注册/登录入口 → dump 后续页面结构。
 * 不填邮箱、不提交验证码、不写数据库。
 *
 * 用法：
 *   node muse-register.js
 *   MUSE_HEADFUL=0 MUSE_KEEP_OPEN=0 node muse-register.js
 *   MUSE_URL=https://muse.ai/ MUSE_PROXY=http://... node muse-register.js
 *
 * Docker：
 *   docker compose up -d --build
 *   docker compose exec app node muse-register.js
 *
 * 输出目录默认 debug_screenshots/muse-debug/<时间戳>/；Docker 下该目录已 bind mount 到宿主机。
 * 每个步骤同时输出 LIVE_SCREENSHOT / VIDEO_FILE 标记，后台「Muse 注册调试」页会实时收集展示。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { connectStandaloneBrowser } = require('./browser-standalone');
const { preparePlaywrightProxy } = require('./playwright-proxy');

function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const CONFIG = {
    url: String(process.env.MUSE_URL || 'https://muse.ai/').trim() || 'https://muse.ai/',
    debugRoot: path.resolve(process.env.MUSE_DEBUG_DIR || path.join(__dirname, 'debug_screenshots', 'muse-debug')),
    headful: String(process.env.MUSE_HEADFUL || '1') !== '0',
    keepOpen: process.env.MUSE_KEEP_OPEN
        ? String(process.env.MUSE_KEEP_OPEN) !== '0'
        : Boolean(process.stdin.isTTY),
    clickSignup: String(process.env.MUSE_CLICK_SIGNUP || '1') !== '0',
    networkLog: String(process.env.MUSE_NETWORK_LOG || '1') !== '0',
    video: String(process.env.MUSE_VIDEO || '1') !== '0',
    videoDir: path.resolve(process.env.MUSE_VIDEO_DIR || path.join(__dirname, 'debug_screenshots', 'videos')),
    proxy: String(process.env.MUSE_PROXY || '').trim(),
    account: String(process.env.MUSE_ACCOUNT || '').trim().slice(0, 320),
    chromiumChannel: String(process.env.MUSE_CHROMIUM_CHANNEL || '').trim(),
    cdpPort: String(process.env.MUSE_CDP_PORT || '9333').trim(),
    navigationTimeoutMs: Number(process.env.MUSE_NAV_TIMEOUT_MS || 90000),
    settleMs: Number(process.env.MUSE_SETTLE_MS || 3000)
};

const RUN_DIR = path.join(CONFIG.debugRoot, stamp());
const VIDEO_TAG = String(process.env.MUSE_JOB_KEY || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || stamp();

function markProgress(value) {
    console.log(`MUSE_PROGRESS: ${value}`);
}

function sanitizeUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^(data|blob|javascript|mailto|tel):/i.test(value)) {
        return value.split('?')[0].slice(0, 160);
    }
    try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
        return value.split('?')[0].split('#')[0].slice(0, 300);
    }
}

function truncate(value, max = 1200) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatInput(input) {
    const parts = [`type=${input.type || '?'}`];
    if (input.name) parts.push(`name=${input.name}`);
    if (input.inputMode) parts.push(`inputmode=${input.inputMode}`);
    if (input.placeholder) parts.push(`placeholder="${truncate(input.placeholder, 60)}"`);
    if (input.ariaLabel) parts.push(`aria="${truncate(input.ariaLabel, 60)}"`);
    parts.push(`visible=${input.visible ? 'yes' : 'no'}`);
    return `{ ${parts.join(' ')} }`;
}

function maskAccount(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.includes('@')) {
        const [local, domain] = text.split('@');
        return `${local.slice(0, 2)}***@${domain}`;
    }
    return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

function formatButton(button) {
    const label = button.text ? `"${truncate(button.text, 60)}"` : '<no text>';
    return `${button.tag}${button.id ? `#${button.id}` : ''} ${label}`;
}

function formatLink(link) {
    return `"${truncate(link.text, 40)}" -> ${link.href || '<no href>'}`;
}

function printCandidates(candidates) {
    console.log(`[Muse] 注册/登录候选 ${candidates.length} 个:`);
    for (const candidate of candidates.slice(0, 12)) {
        console.log(
            `[Muse]   score=${candidate.score} kind=${candidate.kind} ` +
            `tag=${candidate.tag} frame#${candidate.frameIndex} ` +
            `text="${truncate(candidate.text, 60)}" href="${candidate.href}"`
        );
    }
}

// 在页面上下文中执行，不能引用 Node 侧变量。
function collectFrameDom() {
    const MAX_TEXT = 6000;
    const MAX_ITEMS = 250;

    const isVisible = (el) => {
        try {
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (_) {
            return false;
        }
    };
    const clean = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const textOf = (el) => clean(el.innerText || el.value || el.textContent || '');
    const attr = (el, name) => String(el.getAttribute(name) || '');

    const describe = (el) => {
        const rect = el.getBoundingClientRect();
        return {
            tag: String(el.tagName || '').toLowerCase(),
            type: attr(el, 'type'),
            name: attr(el, 'name'),
            id: attr(el, 'id'),
            placeholder: attr(el, 'placeholder'),
            ariaLabel: attr(el, 'aria-label') || attr(el, 'aria-labelledby'),
            autocomplete: attr(el, 'autocomplete'),
            inputMode: attr(el, 'inputmode'),
            role: attr(el, 'role'),
            text: textOf(el),
            href: el.href ? String(el.href) : '',
            visible: isVisible(el),
            rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height)
            }
        };
    };

    return {
        url: location.href,
        title: document.title,
        text: clean(document.body ? document.body.innerText : '', MAX_TEXT),
        inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, MAX_ITEMS).map(describe),
        buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')).slice(0, MAX_ITEMS).map(describe),
        links: Array.from(document.querySelectorAll('a[href]')).slice(0, MAX_ITEMS).map(describe),
        forms: Array.from(document.querySelectorAll('form')).slice(0, 50).map((el) => ({
            action: String(el.action || ''),
            method: String(el.method || ''),
            id: attr(el, 'id'),
            text: textOf(el)
        })),
        iframes: Array.from(document.querySelectorAll('iframe')).slice(0, 50).map((el) => ({
            src: String(el.src || ''),
            name: attr(el, 'name'),
            id: attr(el, 'id'),
            title: attr(el, 'title'),
            visible: isVisible(el)
        })),
        headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 30).map((el) => ({
            tag: String(el.tagName || '').toLowerCase(),
            text: textOf(el)
        }))
    };
}

// 在页面上下文中执行：给候选元素打临时属性，方便 Playwright 精确点击。
function tagSignupCandidates() {
    const isVisible = (el) => {
        try {
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (_) {
            return false;
        }
    };
    const clean = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

    const patterns = [
        { kind: 'signup', score: 100, re: /sign\s*up|signup|register|create\s*(an\s*)?account|open\s*(an\s*)?account|join\s*(now|free)?/i },
        { kind: 'signup', score: 80, re: /get\s*started|start\s*(for\s*)?free|try\s*(it\s*)?free|free\s*trial|continue\s*with\s*(email|phone)/i },
        { kind: 'login', score: 40, re: /log\s*in|sign\s*in|login/i }
    ];

    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'));
    const candidates = [];
    let index = 0;

    for (const el of nodes) {
        if (!isVisible(el)) continue;

        const label = clean(el.innerText || el.value || el.textContent || '');
        const href = String(el.href || '');
        let best = null;
        for (const pattern of patterns) {
            if (pattern.re.test(label) || (href && pattern.re.test(href))) {
                if (!best || pattern.score > best.score) {
                    best = pattern;
                }
            }
        }
        if (!best) continue;

        const debugId = `muse-candidate-${index++}`;
        el.setAttribute('data-muse-debug-id', debugId);
        candidates.push({
            debugId,
            kind: best.kind,
            score: best.score,
            tag: String(el.tagName || '').toLowerCase(),
            text: label,
            href
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

// 在页面上下文中执行。
function detectAuthInput() {
    const isVisible = (el) => {
        try {
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (_) {
            return false;
        }
    };

    return Array.from(document.querySelectorAll('input')).some((el) => {
        if (!isVisible(el)) return false;
        const type = String(el.type || '').toLowerCase();
        const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return type === 'email' || type === 'tel' || /email|phone|mobile/.test(hint);
    });
}

// 在页面上下文中执行：标记首个可见的邮箱/手机号输入框及其提交按钮。
function tagAuthFields() {
    const isVisible = (el) => {
        try {
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (_) {
            return false;
        }
    };
    const clean = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const attr = (el, name) => String(el.getAttribute(name) || '');

    const matches = (el) => {
        const type = String(el.type || '').toLowerCase();
        const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return type === 'email' || type === 'tel' || /email|phone|mobile/.test(hint);
    };

    const input = Array.from(document.querySelectorAll('input')).find((el) => isVisible(el) && matches(el));
    if (!input) return null;

    input.setAttribute('data-muse-auth', 'input');
    const info = {
        type: attr(input, 'type'),
        name: input.name || '',
        id: input.id || '',
        placeholder: clean(input.placeholder, 60),
        ariaLabel: clean(input.getAttribute('aria-label'), 60),
        autocomplete: clean(input.autocomplete, 60),
        inputMode: attr(input, 'inputmode'),
        dataSlot: attr(input, 'data-slot'),
        submit: null
    };

    const scope = input.closest('form') || document;
    const buttons = Array.from(scope.querySelectorAll('button[type="submit"], input[type="submit"], button, [role="button"]'));
    const submit = buttons.find((el) => {
        if (!isVisible(el) || el === input) return false;
        if (String(el.type || '').toLowerCase() === 'submit') return true;
        return /continue|next|submit|sign\s*up|log\s*in/i.test(clean(el.innerText || el.value || el.textContent, 60));
    });

    if (submit) {
        submit.setAttribute('data-muse-auth', 'submit');
        info.submit = {
            tag: String(submit.tagName || '').toLowerCase(),
            type: attr(submit, 'type'),
            text: clean(submit.innerText || submit.value || submit.textContent, 60)
        };
    }
    return info;
}

async function collectPageSummary(page) {
    const frames = [];
    const pageFrames = page.frames();

    for (let i = 0; i < pageFrames.length; i += 1) {
        const frame = pageFrames[i];
        const isMain = frame === page.mainFrame();
        try {
            const data = await frame.evaluate(collectFrameDom);
            frames.push({
                index: i,
                isMain,
                frameUrl: sanitizeUrl(frame.url()),
                url: sanitizeUrl(data.url),
                title: data.title,
                text: data.text,
                inputs: data.inputs,
                buttons: data.buttons,
                links: (data.links || []).map((item) => ({ ...item, href: sanitizeUrl(item.href) })),
                forms: (data.forms || []).map((item) => ({ ...item, action: sanitizeUrl(item.action) })),
                iframes: (data.iframes || []).map((item) => ({ ...item, src: sanitizeUrl(item.src) })),
                headings: data.headings
            });
        } catch (error) {
            frames.push({
                index: i,
                isMain,
                frameUrl: sanitizeUrl(frame.url()),
                url: sanitizeUrl(frame.url()),
                title: '',
                text: '',
                inputs: [],
                buttons: [],
                links: [],
                forms: [],
                iframes: [],
                headings: [],
                error: error.message
            });
        }
    }

    const combined = frames.map((frame) => {
        const iframeUrls = (frame.iframes || []).map((item) => item.src).join(' ');
        return `${frame.url} ${frame.text} ${iframeUrls}`;
    }).join('\n');

    const challengeSignals = [];
    if (/challenges\.cloudflare\.com|turnstile/i.test(combined)) challengeSignals.push('turnstile');
    if (/just a moment|cloudflare|verify you are human|attention required/i.test(combined)) challengeSignals.push('cloudflare');
    if (/hcaptcha\.com/i.test(combined)) challengeSignals.push('hcaptcha');
    if (/recaptcha|google\.com\/recaptcha/i.test(combined)) challengeSignals.push('recaptcha');
    if (/arkoselabs|funcaptcha/i.test(combined)) challengeSignals.push('arkose');

    const authInputs = [];
    for (const frame of frames) {
        for (const input of frame.inputs || []) {
            const type = String(input.type || '').toLowerCase();
            const hint = [input.name, input.id, input.placeholder, input.ariaLabel, input.autocomplete]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            if (type === 'email' || type === 'tel' || /email|phone|mobile/.test(hint)) {
                authInputs.push({
                    frameUrl: frame.url,
                    type: input.type,
                    name: input.name,
                    id: input.id,
                    placeholder: input.placeholder,
                    ariaLabel: input.ariaLabel,
                    visible: input.visible
                });
            }
        }
    }

    return {
        pageUrl: sanitizeUrl(page.url()),
        title: await page.title().catch(() => ''),
        challengeSignals,
        authInputs,
        frames
    };
}

function printPageSummary(label, summary) {
    console.log('');
    console.log(`[Muse] ===== ${label} =====`);
    console.log(`[Muse] url: ${summary.pageUrl || '<unknown>'}`);
    console.log(`[Muse] title: ${summary.title || '<empty>'}`);
    if (summary.error) console.log(`[Muse] error: ${summary.error}`);
    if (summary.challengeSignals && summary.challengeSignals.length) {
        console.log(`[Muse] challenge: ${summary.challengeSignals.join(', ')}`);
    }

    const main = (summary.frames || []).find((frame) => frame.isMain) || (summary.frames || [])[0];
    if (main && main.text) {
        console.log(`[Muse] text: ${truncate(main.text, 1200)}`);
    }

    for (const frame of summary.frames || []) {
        const prefix = frame.isMain ? 'main' : `frame#${frame.index}`;
        const inputs = (frame.inputs || []).filter((item) => item.visible).slice(0, 12);
        const buttons = (frame.buttons || []).filter((item) => item.visible).slice(0, 12);
        const links = (frame.links || []).filter((item) => item.visible).slice(0, 12);
        if (!inputs.length && !buttons.length && !links.length) continue;

        console.log(`[Muse] ${prefix} ${frame.url}:`);
        if (inputs.length) console.log(`[Muse]   inputs: ${inputs.map(formatInput).join(' | ')}`);
        if (buttons.length) console.log(`[Muse]   buttons: ${buttons.map(formatButton).join(' | ')}`);
        if (links.length) console.log(`[Muse]   links: ${links.map(formatLink).join(' | ')}`);
    }

    if (summary.authInputs && summary.authInputs.length) {
        console.log(`[Muse] authInputs: ${summary.authInputs.map(formatInput).join(' | ')}`);
    }
    console.log(`[Muse] saved: ${label}.json / .png / .html`);
}

async function dumpPage(page, label) {
    const base = path.join(RUN_DIR, label);
    let summary;

    try {
        summary = await collectPageSummary(page);
    } catch (error) {
        summary = {
            pageUrl: sanitizeUrl(page.url()),
            title: '',
            error: error.message,
            challengeSignals: [],
            authInputs: [],
            frames: []
        };
    }

    fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2), 'utf8');

    try {
        await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 30000 });
    } catch (_) {
        await page.screenshot({ path: `${base}.png`, fullPage: false, timeout: 30000 }).catch(() => {});
    }
    if (fs.existsSync(`${base}.png`)) {
        console.log(`LIVE_SCREENSHOT: ${base}.png`);
    }

    try {
        fs.writeFileSync(`${base}.html`, await page.content(), 'utf8');
    } catch (_) {
        // 页面可能已关闭或还在导航，忽略即可。
    }

    printPageSummary(label, summary);
    return summary;
}

async function findSignupCandidates(page) {
    const candidates = [];
    const pageFrames = page.frames();

    for (let i = 0; i < pageFrames.length; i += 1) {
        const frame = pageFrames[i];
        try {
            const items = await frame.evaluate(tagSignupCandidates);
            for (const item of items) {
                candidates.push({
                    ...item,
                    frame,
                    frameIndex: i,
                    frameUrl: sanitizeUrl(frame.url()),
                    href: sanitizeUrl(item.href)
                });
            }
        } catch (_) {
            // 跨域或已销毁的 frame，跳过。
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

async function hasAuthInput(page) {
    for (const frame of page.frames()) {
        try {
            if (await frame.evaluate(detectAuthInput)) {
                return true;
            }
        } catch (_) {
            // 跨域或已销毁的 frame，跳过。
        }
    }
    return false;
}

async function clickCandidate(candidate) {
    const selector = `[data-muse-debug-id="${candidate.debugId}"]`;
    const locator = candidate.frame.locator(selector).first();
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await locator.click({ timeout: 15000 });
}

async function awaitAuthInput(page, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await hasAuthInput(page)) return true;
        if (Date.now() >= deadline) return false;
        await page.waitForTimeout(1000);
    }
}

function formatAuthTarget(info) {
    const parts = [];
    if (info.type) parts.push(`type=${info.type}`);
    if (info.inputMode) parts.push(`inputmode=${info.inputMode}`);
    if (info.placeholder) parts.push(`placeholder="${truncate(info.placeholder, 60)}"`);
    if (info.ariaLabel) parts.push(`aria="${truncate(info.ariaLabel, 60)}"`);
    if (info.dataSlot) parts.push(`slot=${info.dataSlot}`);
    parts.push(info.submit ? `按钮="${truncate(info.submit.text, 40)}"` : '按钮=<无 submit，改用回车>');
    return parts.join(' ');
}

async function fillAuthInputAndSubmit(page, account) {
    const pageFrames = page.frames();
    for (let i = 0; i < pageFrames.length; i += 1) {
        const frame = pageFrames[i];
        let info = null;
        try {
            info = await frame.evaluate(tagAuthFields);
        } catch (_) {
            // 跨域或已销毁的 frame，跳过。
            continue;
        }
        if (!info) continue;

        const input = frame.locator('[data-muse-auth="input"]').first();
        console.log(`[Muse] 填写邮箱/手机号 frame#${i} ${formatAuthTarget(info)} <- ${maskAccount(account)}`);
        await input.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        try {
            await input.click({ timeout: 10000 });
            await input.fill(account, { timeout: 10000 });
        } catch (error) {
            console.error(`[Muse] 输入框填写失败: ${error.message}`);
            return false;
        }
        markProgress(75);

        const submit = frame.locator('[data-muse-auth="submit"]').first();
        try {
            if (await submit.count()) {
                await submit.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
                await submit.click({ timeout: 15000 });
            } else {
                await input.press('Enter');
            }
        } catch (error) {
            console.error(`[Muse] 提交按钮点击失败，改用回车: ${error.message}`);
            await input.press('Enter').catch(() => {});
        }
        return true;
    }
    return false;
}

function attachNetworkLog(context) {
    if (!CONFIG.networkLog) {
        return { file: '', close: () => {} };
    }

    const file = path.join(RUN_DIR, 'network.jsonl');
    const stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {});

    const write = (entry) => {
        try {
            stream.write(`${JSON.stringify(entry)}\n`);
        } catch (_) {
            // 关闭阶段忽略写入错误。
        }
    };

    context.on('response', (response) => {
        try {
            const request = response.request();
            const type = request.resourceType();
            if (!['document', 'xhr', 'fetch'].includes(type)) return;
            const rawUrl = response.url();
            if (/^(data|blob|about):/i.test(rawUrl)) return;
            write({
                at: new Date().toISOString(),
                method: request.method(),
                type,
                status: response.status(),
                url: sanitizeUrl(rawUrl)
            });
        } catch (_) {
            // 忽略无法读取的响应。
        }
    });

    context.on('requestfailed', (request) => {
        try {
            const type = request.resourceType();
            if (!['document', 'xhr', 'fetch'].includes(type)) return;
            const rawUrl = request.url();
            if (/^(data|blob|about):/i.test(rawUrl)) return;
            write({
                at: new Date().toISOString(),
                method: request.method(),
                type,
                status: 'failed',
                error: request.failure() ? request.failure().errorText : '',
                url: sanitizeUrl(rawUrl)
            });
        } catch (_) {
            // 忽略。
        }
    });

    return { file, close: () => stream.end() };
}

function waitForEnter(message) {
    if (!process.stdin.isTTY) {
        console.log(`${message}(非交互环境，跳过等待)`);
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(message, () => {
            rl.close();
            resolve();
        });
    });
}

function collectVideoHandles(context) {
    if (!context || typeof context.pages !== 'function') {
        return [];
    }
    const handles = [];
    for (const item of context.pages()) {
        try {
            const video = item.video ? item.video() : null;
            if (video) handles.push(video);
        } catch (_) {
            // 页面可能已关闭，忽略。
        }
    }
    return handles;
}

async function finalizeVideo(context) {
    if (!CONFIG.video || !context) {
        if (context) await context.close().catch(() => {});
        return [];
    }

    const handles = collectVideoHandles(context);
    await context.close().catch(() => {});
    if (!handles.length) {
        return [];
    }

    fs.mkdirSync(CONFIG.videoDir, { recursive: true });
    const saved = [];
    for (let i = 0; i < handles.length; i += 1) {
        const rawPath = await handles[i].path().catch(() => null);
        if (!rawPath) continue;
        const finalPath = path.join(CONFIG.videoDir, `muse_${VIDEO_TAG}_${i + 1}_${Date.now()}.webm`);
        try {
            fs.renameSync(rawPath, finalPath);
        } catch (_) {
            try {
                fs.copyFileSync(rawPath, finalPath);
                fs.unlinkSync(rawPath);
            } catch (_) {
                saved.push(rawPath);
                console.log(`VIDEO_FILE: ${rawPath}`);
                continue;
            }
        }
        saved.push(finalPath);
        console.log(`[Muse] 录像已保存: ${finalPath}`);
        console.log(`VIDEO_FILE: ${finalPath}`);
    }
    return saved;
}

async function run() {
    fs.mkdirSync(RUN_DIR, { recursive: true });

    console.log(`[Muse] 侦察开始 url=${CONFIG.url}`);
    console.log(`[Muse] 日志目录 ${RUN_DIR}`);
    console.log(`[Muse] headful=${CONFIG.headful} proxy=${CONFIG.proxy ? 'yes' : 'no'} clickSignup=${CONFIG.clickSignup} account=${CONFIG.account ? maskAccount(CONFIG.account) : '<none>'}`);

    const preparedProxy = await preparePlaywrightProxy(CONFIG.proxy);
    let session = null;
    let context = null;
    let page = null;
    let networkLog = null;
    let failed = false;

    try {
        session = await connectStandaloneBrowser({
            proxyConfig: preparedProxy.proxyConfig,
            headful: CONFIG.headful,
            chromiumChannel: CONFIG.chromiumChannel,
            cdpPort: CONFIG.cdpPort
        });

        context = await session.browser.newContext({
            viewport: { width: 1440, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/Chicago',
            ignoreHTTPSErrors: true,
            ...(CONFIG.video ? { recordVideo: { dir: CONFIG.videoDir, size: { width: 1440, height: 900 } } } : {})
        });
        markProgress(15);

        networkLog = attachNetworkLog(context);
        page = await context.newPage();
        page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
        page.on('crash', () => console.error('[Muse] 页面崩溃'));
        context.on('page', (newPage) => {
            console.log(`[Muse] 新页面: ${sanitizeUrl(newPage.url())}`);
        });

        await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navigationTimeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await dumpPage(page, '01-home');
        markProgress(40);

        if (CONFIG.clickSignup) {
            const authReady = await hasAuthInput(page);
            if (authReady) {
                console.log('[Muse] 首页已经出现邮箱/手机号输入框，跳过注册入口点击');
                markProgress(70);
            } else {
                const candidates = await findSignupCandidates(page);
                printCandidates(candidates);

                if (!candidates.length) {
                    console.log('[Muse] 未找到注册/登录候选。可查看 01-home.html，或设置 MUSE_CLICK_SIGNUP=0 仅抓首页。');
                } else {
                    const target = candidates[0];
                    console.log(
                        `[Muse] 点击候选: ${target.kind} score=${target.score} ` +
                        `text="${truncate(target.text, 60)}" href="${target.href}" frame#${target.frameIndex}`
                    );

                    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
                    markProgress(55);
                    try {
                        await clickCandidate(target);
                    } catch (error) {
                        console.error(`[Muse] 点击失败: ${error.message}`);
                    }

                    const popup = await popupPromise;
                    await page.waitForTimeout(CONFIG.settleMs);
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                    await dumpPage(page, '02-after-signup-click');
                    markProgress(80);

                    if (popup) {
                        await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.navigationTimeoutMs }).catch(() => {});
                        await popup.waitForTimeout(1500);
                        await dumpPage(popup, '03-popup');
                        markProgress(88);
                    }

                    const seen = new Set([page, popup].filter(Boolean));
                    const pages = context.pages();
                    for (let i = 0; i < pages.length; i += 1) {
                        if (seen.has(pages[i])) continue;
                        await dumpPage(pages[i], `04-extra-page-${i + 1}`).catch(() => {});
                    }
                }
            }
        }
        if (CONFIG.account) {
            try {
                if (await awaitAuthInput(page)) {
                    const submitted = await fillAuthInputAndSubmit(page, CONFIG.account);
                    if (submitted) {
                        await page.waitForTimeout(CONFIG.settleMs);
                        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                        await dumpPage(page, '05-after-continue');
                        markProgress(82);

                        const others = context.pages().filter((item) => item !== page);
                        for (let i = 0; i < others.length; i += 1) {
                            await dumpPage(others[i], `06-after-continue-page-${i + 1}`).catch(() => {});
                        }
                        markProgress(90);
                    }
                } else {
                    console.log('[Muse] 没有等到邮箱/手机号输入框，跳过填写步骤。');
                }
            } catch (error) {
                // 提交后可能正在跳转，这里失败不应丢掉已导出的首屏结果。
                console.error(`[Muse] 提交后侦察失败: ${error.message}`);
            }
        }
    } catch (error) {
        failed = true;
        console.error(`[Muse] 侦察失败: ${error.stack || error.message}`);
        if (page) {
            await dumpPage(page, '99-error').catch(() => {});
        }
        process.exitCode = 1;
    } finally {
        if (CONFIG.keepOpen && context) {
            await waitForEnter('[Muse] 浏览器保持打开，按 Enter 关闭... ');
        }
        markProgress(95);
        await finalizeVideo(context);
        if (session && session.browser) await session.browser.close().catch(() => {});
        if (networkLog) networkLog.close();
        if (preparedProxy && preparedProxy.cleanup) await preparedProxy.cleanup().catch(() => {});
        if (!failed) {
            console.log('MUSE_DEBUG_DONE');
            markProgress(100);
        }
        console.log(`[Muse] 结束，日志在 ${RUN_DIR}`);
    }
}

run().catch((error) => {
    console.error(`[Muse] 未捕获异常: ${error.stack || error.message}`);
    process.exitCode = 1;
});
