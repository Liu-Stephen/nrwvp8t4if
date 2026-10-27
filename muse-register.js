'use strict';

/**
 * muse.ai 注册链路脚本
 *
 * 流程：打开站点 → 填邮箱/手机号 → 等后台人工下发验证码 → 改写 app 自己发出的 register-completion
 * 请求体带上成年生日 → 新号过 disclosure 点 Get started、老号登录后直接落卡页 → 在
 * /access/verification 用卡池里的真卡确认年龄（$1 押金，5-7 工作日退）。
 * 每一步都导出 json / png / html 到 debug_screenshots/muse-debug/<时间戳>/。
 *
 * 会写数据库：reserveCard / recordCardUsage / markCardExhausted / releaseCard 走现有卡池的行锁，邮编走现有免税地址池（选地址会改写 last_used_address_id）。
 * 结账判据只看网络响应：POST /api/checkout/finalize 的 2xx 才记一次使用（那才是 $1 真扣了），
 * checkout/credential|finalize 的 4xx 且响应体里有明确拒付措辞才报废这张卡（isPaymentDeclined，代充那边同一套）；
 * 读不出拒付措辞、5xx 与「90 秒等不到响应」都只报现场，不记账也不报废。
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
const store = require('./mysql-store');
const { pickBillingAddressForCheckout } = require('./tax-free-address');
const { normalizeCardNumber, normalizeCardExpiry } = require('./stripe-payment');
// 代充那边「只有明确拒付才报废」用的就是这个关键词表，绑卡这边照它对齐，别自己定一套。
const { isPaymentDeclined } = require('./payment-retry');

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
    birthday: String(process.env.MUSE_BIRTHDAY || '').trim().slice(0, 32),
    chromiumChannel: String(process.env.MUSE_CHROMIUM_CHANNEL || '').trim(),
    cdpPort: String(process.env.MUSE_CDP_PORT || '9333').trim(),
    navigationTimeoutMs: Number(process.env.MUSE_NAV_TIMEOUT_MS || 90000),
    settleMs: Number(process.env.MUSE_SETTLE_MS || 3000),
    otpTimeoutMs: Number(process.env.MUSE_OTP_TIMEOUT_MS || 300000),
    humanize: String(process.env.MUSE_HUMANIZE || '1') !== '0'
};

const RUN_DIR = path.join(CONFIG.debugRoot, stamp());
const VIDEO_TAG = String(process.env.MUSE_JOB_KEY || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || stamp();
// 卡池的预留人：跑挂了也能从 locked_by 认出是哪一轮占着卡。
const CARD_OWNER = `muse_${VIDEO_TAG}`.slice(0, 64);

function markProgress(value) {
    console.log(`MUSE_PROGRESS: ${value}`);
}

function randInt(min, max) {
    const low = Math.max(0, Math.round(min));
    const high = Math.max(low, Math.round(max));
    return low + Math.floor(Math.random() * (high - low + 1));
}

async function humanPause(page, min, max) {
    const ms = CONFIG.humanize ? randInt(min, max) : Math.max(0, min);
    await page.waitForTimeout(ms).catch(() => {});
}

// 鼠标不是瞬移的：从上一个落点滑行到目标，中途带一点抖动，终点停在元素中心附近而不是正中。
// 支付链路已有一份同类实现（human-verification.js 的 humanMouseMove），但它所在模块 require 了验证码求解依赖，
// 侦察脚本要保持独立，所以这里各留一份，改节奏时记得两边都看。
let cursor = null;

async function glideMouse(page, x, y) {
    if (!CONFIG.humanize) {
        await page.mouse.move(x, y).catch(() => {});
        cursor = { x, y };
        return;
    }
    const from = cursor || { x: randInt(200, 1200), y: randInt(200, 700) };
    // 真人指针是按屏幕帧率出点的：大约每 20px 报一个位置、每个位置一帧（12~20ms）。
    // 所以步数和总时长都跟着距离走：900px 一趟约 45 步、600~900ms，短距离移动才不会拖泥带水。
    const steps = Math.min(50, Math.max(8, Math.round(Math.hypot(x - from.x, y - from.y) / 20)));
    for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const jitter = i === steps ? 0 : randInt(-3, 3);
        // 页面可能在这一下之前就关了（验证码提交后换屏），滑行失败不该把后面的截图整段带走。
        await page.mouse.move(from.x + (x - from.x) * ease + jitter, from.y + (y - from.y) * ease + jitter).catch(() => {});
        await humanPause(page, 12, 20);
    }
    cursor = { x, y };
}

async function humanClick(page, locator) {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (box && box.width >= 6 && box.height >= 6) {
        const x = randInt(Math.round(box.width * 0.3), Math.round(box.width * 0.7));
        const y = randInt(Math.round(box.height * 0.3), Math.round(box.height * 0.7));
        await glideMouse(page, box.x + x, box.y + y);
        await humanPause(page, 70, 220);
        try {
            await locator.click({ timeout: 15000, position: { x, y } });
            return true;
        } catch (error) {
            // 按下之后页面也可能已经跳转并报这个错，再补一次点击就是二次提交，交给调用方兜底。
            console.log(`[Muse] 偏移点击没成功，交给调用方兜底: ${error.message}`);
            return false;
        }
    }
    // 走到这里说明盒子太小或拿不到：sr-only 输入框是 1×1，硬点会被上层 role="presentation"
    // 的容器拦住指针，白等 10 秒还会打一大段 Playwright 重试日志。聚焦后照样能敲键盘。
    await locator.focus({ timeout: 5000 }).catch(() => {});
    return false;
}

// 逐字符敲键，敲完回读；没落上就退回 fill，避免为了节奏把表单填空。
async function typeInto(page, locator, text, minDelay = 60, maxDelay = 180) {
    if (!CONFIG.humanize) {
        await locator.fill(String(text), { timeout: 10000 }).catch((error) => {
            console.error(`[Muse] fill 失败: ${error.message}`);
        });
        return;
    }
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await humanClick(page, locator);
    await humanPause(page, 140, 460);
    const chars = Array.from(String(text));
    for (let i = 0; i < chars.length; i += 1) {
        await page.keyboard.type(chars[i]);
        await page.waitForTimeout(randInt(minDelay, maxDelay));
        if (chars[i] === '@' || chars[i] === '.') {
            await humanPause(page, 200, 520);
        }
    }
    const typed = await locator.evaluate((el) => String(el.value || '')).catch(() => '');
    // 卡号框会自己每 4 位插一个空格（cc-number 的 maxlength=19 就是这么来的），
    // 按原样比长度会把每张 16 位卡都判成「没落上」，再用 fill 把明文重写一遍。
    const typedLen = typed.replace(/\s+/g, '').length;
    if (typedLen !== chars.length) {
        console.log(`[Muse] 逐字符输入后只剩 ${typedLen}/${chars.length} 位，改用 fill`);
        await locator.fill(String(text), { timeout: 10000 }).catch((error) => {
            console.error(`[Muse] fill 兜底失败: ${error.message}`);
        });
    }
}

// 首屏先像访客一样滚两下，别一进来就直奔输入框。
async function idleBrowse(page) {
    if (!CONFIG.humanize) return;
    for (let i = 0; i < randInt(2, 3); i += 1) {
        await page.mouse.wheel(0, randInt(180, 420)).catch(() => {});
        await humanPause(page, 400, 1200);
    }
    await page.mouse.wheel(0, -randInt(300, 700)).catch(() => {});
    await humanPause(page, 300, 900);
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

function maskEmails(value) {
    return String(value || '').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (match) => maskAccount(match));
}

// 拒付响应体要的是 code/decline_code 这类字符串，长数字串只会是卡号回显，读日志之前先挡掉。
function maskCardEchoes(value) {
    return String(value || '')
        .replace(/\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}/g, '<卡号>')
        .replace(/\d{12,19}/g, '<长数字>');
}

// 生日留空时随机取 22~32 岁；日只到 28，避免造出非法日期。
function resolveBirthday() {
    const raw = CONFIG.birthday;
    const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (matched) {
        const year = Number(matched[1]);
        const month = Number(matched[2]);
        const day = Number(matched[3]);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
            return { year, month, day, source: '指定' };
        }
    }
    if (raw) {
        console.log(`[Muse] MUSE_BIRTHDAY="${raw}" 不是有效的 YYYY-MM-DD，改用随机生日`);
    }
    const age = 22 + Math.floor(Math.random() * 11);
    return {
        year: new Date().getUTCFullYear() - age,
        month: 1 + Math.floor(Math.random() * 12),
        day: 1 + Math.floor(Math.random() * 28),
        source: `随机 ${age} 岁`
    };
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

// 在页面上下文中执行：标记验证码输入框（Muse 用的是 sr-only 单框 + 6 个装饰格子）及其提交按钮。
function tagOtpFields() {
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
        if (String(el.autocomplete || '').toLowerCase() === 'one-time-code') return true;
        const maxLength = Number(el.getAttribute('maxlength') || 0);
        const hint = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return maxLength >= 4 && maxLength <= 8 && /(code|otp|pin|verif)/.test(hint);
    };

    const input = Array.from(document.querySelectorAll('input')).find(matches);
    if (!input) return null;

    input.setAttribute('data-muse-otp', 'input');
    const info = {
        type: attr(input, 'type'),
        inputMode: attr(input, 'inputmode'),
        maxLength: attr(input, 'maxlength'),
        autocomplete: clean(input.autocomplete, 60),
        ariaLabel: clean(input.getAttribute('aria-label'), 60),
        hidden: !isVisible(input),
        boxes: document.querySelectorAll('[data-slot="pin-digit"]').length,
        submit: null
    };

    const scope = input.closest('form') || document;
    const submit = Array.from(scope.querySelectorAll('button[type="submit"], input[type="submit"], button, [role="button"]')).find((el) => {
        if (!isVisible(el) || el === input) return false;
        if (String(el.type || '').toLowerCase() === 'submit') return true;
        return /confirm|submit|verify|next/i.test(clean(el.innerText || el.value || el.textContent, 60));
    });

    if (submit) {
        submit.setAttribute('data-muse-otp', 'submit');
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

    // 先截图、后读 DOM：截图本身要一两秒，SPA 恰好拿这一拍把节点挂完。
    // 反过来就会导出「JSON 空壳、PNG 整页」的现场（153916 的 08）。
    try {
        await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 30000 });
    } catch (_) {
        await page.screenshot({ path: `${base}.png`, fullPage: false, timeout: 30000 }).catch(() => {});
    }
    if (fs.existsSync(`${base}.png`)) {
        console.log(`LIVE_SCREENSHOT: ${base}.png`);
    }

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

async function clickCandidate(page, candidate) {
    const selector = `[data-muse-debug-id="${candidate.debugId}"]`;
    const locator = candidate.frame.locator(selector).first();
    await humanClick(page, locator);
}

async function awaitAuthInput(page, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await hasAuthInput(page)) return true;
        if (Date.now() >= deadline) return false;
        await humanPause(page, 600, 1300);
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
        await humanPause(page, 500, 1400);
        try {
            await typeInto(page, input, account);
        } catch (error) {
            console.error(`[Muse] 输入框填写失败: ${error.message}`);
            return false;
        }
        markProgress(75);

        const submit = frame.locator('[data-muse-auth="submit"]').first();
        try {
            if (await submit.count()) {
                // 敲完不会马上按提交，留一段「看一眼再点」的间隔。
                await humanPause(page, 600, 1800);
                if (!await humanClick(page, submit)) {
                    console.log('[Muse] 提交按钮没点到，改用回车提交');
                    await input.press('Enter').catch(() => {});
                }
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

async function findOtpField(page) {
    const pageFrames = page.frames();
    for (let i = 0; i < pageFrames.length; i += 1) {
        try {
            const info = await pageFrames[i].evaluate(tagOtpFields);
            if (info) {
                return { frameIndex: i, info };
            }
        } catch (_) {
            // 跨域或已销毁的 frame，跳过。
        }
    }
    return null;
}

function formatOtpTarget(info) {
    const parts = [];
    if (info.type) parts.push(`type=${info.type}`);
    if (info.inputMode) parts.push(`inputmode=${info.inputMode}`);
    if (info.maxLength) parts.push(`maxlength=${info.maxLength}`);
    if (info.autocomplete) parts.push(`ac="${info.autocomplete}"`);
    if (info.ariaLabel) parts.push(`aria="${truncate(info.ariaLabel, 60)}"`);
    parts.push(`格子=${info.boxes}`);
    parts.push(info.hidden ? '输入框=sr-only' : '输入框=可见');
    parts.push(info.submit ? `按钮="${truncate(info.submit.text, 40)}"` : '按钮=<无 submit，改用回车>');
    return parts.join(' ');
}

// 等后台把验证码写进子进程 stdin。等待期间持续打印，避免被父进程的无输出超时杀掉。
function waitForInputCode(timeoutMs) {
    console.log('MUSE_INPUT_REQUIRED: otp');
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin });
        const deadline = Date.now() + timeoutMs;
        let done = false;

        const finish = (value, reason) => {
            if (done) return;
            done = true;
            clearInterval(heartbeat);
            clearTimeout(timer);
            rl.close();
            // 不放开 stdin 的话，子进程会因为一直挂着读端而不退出。
            process.stdin.pause();
            if (typeof process.stdin.unref === 'function') {
                process.stdin.unref();
            }
            if (!value) {
                console.log(`[Muse] 未取得验证码（${reason}）`);
            }
            resolve(value);
        };

        const heartbeat = setInterval(() => {
            const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            console.log(`[Muse] 等待后台填入验证码... 剩余 ${left}s`);
        }, 20000);

        const timer = setTimeout(() => finish('', `超时 ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

        rl.on('line', (line) => {
            const digits = String(line).replace(/\D/g, '').slice(0, 8);
            if (!digits) {
                console.log('[Muse] 忽略空/非数字输入');
                return;
            }
            console.log(`[Muse] 收到验证码 digits=${digits.length}`);
            finish(digits, '');
        });
        rl.on('close', () => finish('', 'stdin 已关闭'));
    });
}

async function fillOtpAndSubmit(page, code) {
    const pageFrames = page.frames();
    for (let i = 0; i < pageFrames.length; i += 1) {
        const frame = pageFrames[i];
        let info = null;
        try {
            info = await frame.evaluate(tagOtpFields);
        } catch (_) {
            continue;
        }
        if (!info) continue;

        const input = frame.locator('[data-muse-otp="input"]').first();
        console.log(`[Muse] 填写验证码 frame#${i} ${formatOtpTarget(info)}`);
        // 真人拿到码也是先看一眼再敲，不会瞬间灌进去。
        await humanPause(page, 700, 1800);
        await typeInto(page, input, code, 90, 260).catch((error) => {
            console.error(`[Muse] 验证码输入失败: ${error.message}`);
        });

        // 六位一落这个页面会自己提交（confirm-otp 不需要点确认），提交后输入框被清空、整屏换掉，
        // 所以 el.value 不能当成功信号：只看这一屏还在不在、确认按钮还是不是灰的。
        if ((await input.count()) === 0) {
            console.log('[Muse] 验证码已经自动提交，第二屏已经不在了');
            markProgress(90);
            return true;
        }
        const submit = frame.locator('[data-muse-otp="submit"]').first();
        const value = await input.evaluate((el) => String(el.value || '')).catch(() => '');
        const confirmReady = await submit.isEnabled().catch(() => false);
        if (value.length !== code.length && !confirmReady) {
            // 装饰格子由 React state 驱动，确认按钮还是灰的才说明确实没落上。
            console.log(`[Muse] 验证码只落上 ${value.length} 位，清空重敲`);
            await input.evaluate((el) => {
                el.value = '';
                el.focus();
            }).catch(() => {});
            await page.keyboard.type(code, { delay: 110 }).catch(() => {});
        } else if (value.length !== code.length) {
            console.log('[Muse] 输入框已清空但确认按钮可用，按已提交处理，不重敲废码');
        }
        markProgress(90);
        try {
            if (await submit.count()) {
                await humanPause(page, 500, 1500);
                if (!await humanClick(page, submit)) {
                    // 点不上多半是六位一落页面自己提交并跳走了（025224 就是这样导航到 /access/verification 的），
                    // 这时候再对着已经失效的旧 locator 按回车，只会在卡页上白等 30 秒的超时。
                    // frame 被导航销毁时 count 会直接报错，报错也照样当「第二屏不在了」。
                    if ((await input.count().catch(() => 0)) === 0) {
                        console.log('[Muse] 确认没点到，但第二屏已经换掉，按已自动提交处理');
                        return true;
                    }
                    console.log('[Muse] 确认按钮没点到，改用回车提交');
                    await input.press('Enter').catch(() => {});
                }
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

// app 在生日屏一 mount 就拿默认值（今天，0 岁）发一发 register-completion，实测比任何 UI 动作都早
// （140708：confirm-otp 200 后 2.36 s 发出 {"date_of_birth":"2026-10-26"}，我们 18 s 后才开始碰下拉）。
// 所以成年生日只能改写它自己那一发的请求体；date_of_birth 是唯一带生日的字段，其余字段原样保留。
async function holdAdultBirthday(page, birthday) {
    const iso = `${birthday.year}-${String(birthday.month).padStart(2, '0')}-${String(birthday.day).padStart(2, '0')}`;
    await page.route('**/api/auth/native/register-completion', async (route) => {
        const raw = route.request().postData() || '';
        // 只就地换 date_of_birth 的那 10 个字符：整包 parse/stringify 会改字节长度，
        // 而浏览器带上去的 Content-Length 不一定跟着改，服务端会读到截断或多余的 JSON。
        const next = raw.replace(/("date_of_birth":")[^"]{10}(")/, `$1${iso}$2`);
        if (next === raw) {
            console.log('[Muse] register-completion 请求体里没有 date_of_birth，原样放行。');
            await route.continue().catch(() => {});
            return;
        }
        console.log(`[Muse] 改写 register-completion 生日 -> ${iso}（${birthday.source}）`);
        // network.jsonl 里的 postData 可能是改写前的，这里以出网体为准。
        console.log(`[Muse] 出网体 ${truncate(maskEmails(next), 500)}`);
        await route.continue({ postData: next }).catch(() => {});
    });
    console.log(`[Muse] 已挂上 register-completion 生日改写，目标日期=${iso}`);
}

// /access/verification「Confirm your age」只要 4 个字段，而且全在主文档里（153916 的 08 html 实测，
// 没有 Stripe iframe）：cc-number / cc-exp / cc-csc / postal-code，国家下拉默认就是 United States。
// 这页写明会真扣 $1.00（5-7 个工作日退），所以卡走现有卡池的行锁预留、邮编走现有免税地址池。
async function fillCardAndConfirm(page, context) {
    // 四个框都看得见才动手：typeInto 点不上目标时会退回纯键盘，那一串字符就敲进上一个还持焦点的框里。
    // 用可见而不是节点在不在，和上面那步判「到没到卡页」用同一个口径（isVisible），两边不会各说一套。
    const fields = {
        number: page.locator('input[autocomplete="cc-number"]').first(),
        expiry: page.locator('input[autocomplete="cc-exp"]').first(),
        cvc: page.locator('input[autocomplete="cc-csc"]').first(),
        postal: page.locator('input[autocomplete="postal-code"]').first()
    };
    const missing = [];
    for (const [key, locator] of Object.entries(fields)) {
        if (!(await locator.isVisible().catch(() => false))) missing.push(key);
    }
    if (missing.length) {
        console.log(`[Muse] 这一屏缺 ${missing.join('/')} 输入框，跳过绑卡。`);
        return;
    }

    let card = null;
    try {
        card = await store.reserveCard(CARD_OWNER);
        if (!card) {
            console.log('[Muse] 卡池没有可用卡（占用中/冷却/已报废），跳过绑卡。');
            return;
        }
        // 选地址会顺手改写共享键 last_used_address_id（tax-free-address.js:349），
        // 那是代充支付用来「别连着重复同一地址」的提示，所以点一次调试注册会影响那边的选取。
        const lastUsedRaw = await store.getAppConfigValue('last_used_address_id', null);
        const address = await pickBillingAddressForCheckout(lastUsedRaw ? Number(lastUsedRaw) : null);
        const number = normalizeCardNumber(card.card_number);
        const expiry = normalizeCardExpiry(card.card_expiry);
        const last4 = number.slice(-4);
        console.log(`[Muse] 已预留卡 ...${last4}（第 ${card.usage_count + 1} 次使用）邮编=${address.postal_code}（${address.generated ? '随机生成' : `地址池 #${address.id}`}）`);

        await typeInto(page, fields.number, number);
        await typeInto(page, fields.expiry, expiry);
        await typeInto(page, fields.cvc, String(card.card_cvc || ''));
        await typeInto(page, fields.postal, String(address.postal_code || ''));

        // 只回读掩码后的结果：卡号末四位、CVV 位数、有效期是否落上，明文不进日志也不进导出包。
        const readBack = await page.evaluate(() => {
            const val = (name) => {
                const el = document.querySelector(`input[autocomplete="${name}"]`);
                return el ? String(el.value || '') : '';
            };
            return { number: val('cc-number'), expiry: val('cc-exp'), cvc: val('cc-csc'), postal: val('postal-code') };
        }).catch(() => null);
        console.log(readBack
            ? `[Muse] 卡页回读 卡号=...${readBack.number.replace(/\D/g, '').slice(-4)} 有效期=${readBack.expiry ? '<已填>' : '<空>'} CVV=${readBack.cvc ? `${readBack.cvc.length} 位` : '<空>'} 邮编=${readBack.postal || '<空>'}`
            : '[Muse] 卡页回读失败（页面可能已跳转）');

        const confirm = page.locator('button', { hasText: 'Confirm' }).first();
        if (!(await confirm.count())) {
            console.log('[Muse] 没找到 Confirm 按钮，保留现场不提交。');
            return;
        }
        // 结账那两发都在主文档（031034：checkout/credential 200 → checkout/finalize 200 → 3 秒后离开这页）。
        // 判据分两种：finalize 的 2xx = $1 真扣了；这两发任意一发回 4xx = 这张卡可能被拒。
        // 5xx 不算拒卡（那是 Meta 自己的服务问题），所以不放进等待条件，免得白烧一张。
        await humanPause(page, 900, 2200);
        // 监听器得赶在点下去之前挂好，否则响应会先于等待到达 —— 但停顿不放这儿，那 2 秒也是窗口里的。
        const isPaid = (response) => /\/api\/checkout\/finalize/i.test(response.url())
            && response.status() >= 200 && response.status() < 300;
        const isRejected = (response) => /\/api\/checkout\/(credential|finalize)/i.test(response.url())
            && response.status() >= 400 && response.status() < 500;
        // 90 s：031034 从挂监听到 finalize 只花 18 s，但同一轮 humanClick 撞过一次 15 s 超时，
        // 而它最坏要吃 scrollIntoView 5 s + 停顿 2.4 s + click 15 s + settle 3 s ≈ 25 s，全算在 Meta 之前。
        // 后台的无输出超时是 3 分钟（server.js:30），90 s 不会把子进程杀掉。
        const checkout = page.waitForResponse((response) => isPaid(response) || isRejected(response), { timeout: 90000 })
            .catch(() => null);
        if (!await humanClick(page, confirm)) {
            console.log('[Muse] Confirm 没点到，保留现场。');
        }
        await settleAfterAction(page);
        const outcome = await checkout;
        await dumpPage(page, '09-after-card-confirm');
        await dumpExtraPages(context, page, '09-after-card-confirm-page');

        console.log(`[Muse] 卡页提交后 url=${sanitizeUrl(page.url())} 卡号框还在=${await fields.number.count().catch(() => 0) ? 'yes' : 'no'}`);
        if (!outcome) {
            console.log(`[Muse] 90s 内没等到 checkout/credential|finalize 的 4xx，也没有 finalize 的 2xx，...${last4} 本轮不记账（原因看 09-after-card-confirm）`);
        } else if (isPaid(outcome)) {
            // 只有这一条路径记使用：点歪、字段校验没过都没花钱；finalize 都 2xx 了还不记，就是让下一轮拿同一张卡再刷 $1。
            const usage = await store.recordCardUsage(card.id);
            console.log(`[Muse] checkout/finalize ${outcome.status()} → ...${last4} 记一次使用（日累计 ${usage.dailyUsageCount}${usage.cooledDown ? '，已触发 24 小时冷却' : ''}）`);
        } else {
            // 4xx 不一定是卡的错：ZIP 取自免税地址池、池空时还随机生成（tax-free-address.js:266），
            // 那不是这张卡的真实账单地址，Meta 若校验 AVS 就会回 4xx。而报废撤不回来 ——
            // 后台只有 GET/import/DELETE（server.js:2904），重新导入还会被查重跳过（mysql-store.js:3225）。
            // 所以沿用代充那边的规矩：响应体里有明确拒付措辞才报废（payment-retry.js:203）。
            const step = sanitizeUrl(outcome.url()).replace(/^https?:\/\//, '');
            const detail = maskCardEchoes(maskEmails(await outcome.text().catch(() => '')));
            const reason = truncate(detail, 300) || '响应体为空';
            if (isPaymentDeclined(detail)) {
                await store.markCardExhausted(card.id).catch((error) => console.error(`[Muse] 报废卡片失败: ${error.message}`));
                console.log(`[Muse] ${step} ${outcome.status()} → ...${last4} 已报废（拒因: ${reason}）`);
            } else {
                console.log(`[Muse] ${step} ${outcome.status()} → ...${last4} 保留，响应体里没有拒付措辞（原因: ${reason}）`);
            }
        }
    } catch (error) {
        console.error(`[Muse] 绑卡这步失败: ${error.message}`);
    } finally {
        // 卡池的 in_use 是行锁，不管这一步成没成都要放回去。
        if (card) await store.releaseCard(card.id).catch((error) => console.error(`[Muse] 释放卡片失败: ${error.message}`));
    }
}

async function dumpExtraPages(context, page, prefix) {
    const others = context.pages().filter((item) => item !== page);
    for (let i = 0; i < others.length; i += 1) {
        await dumpPage(others[i], `${prefix}-${i + 1}`).catch(() => {});
    }
}

async function settleAfterAction(page) {
    await humanPause(page, CONFIG.settleMs - 400, CONFIG.settleMs + 900);
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
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

    // 生日到底以什么字段发出去全靠这一行，请求体先存一份（邮箱打码）。
    // 只存 register-completion：confirm-otp 的体里是登录验证码，写进日志和导出产物没有意义。
    context.on('request', (request) => {
        try {
            const rawUrl = request.url();
            if (!/\/api\/auth\/native\/register-completion/i.test(rawUrl)) return;
            const body = request.postData();
            if (!body) return;
            write({
                at: new Date().toISOString(),
                kind: 'request',
                method: request.method(),
                url: sanitizeUrl(rawUrl),
                postData: truncate(maskEmails(body), 2000)
            });
        } catch (_) {
            // 二进制请求体读不出来，跳过。
        }
    });

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
            // 注册链路上的报错全靠这个，否则 403 只能看到状态码；结账那两发的 4xx 就是拒卡原因。
            const isCheckout = /\/api\/checkout\//i.test(rawUrl);
            if (response.status() >= 400 && (/\/api\/auth\/native\//i.test(rawUrl) || isCheckout)) {
                response.text().then((body) => {
                    write({
                        at: new Date().toISOString(),
                        method: request.method(),
                        type,
                        status: response.status(),
                        url: sanitizeUrl(rawUrl),
                        // 结账响应体可能回显卡号，写进导出产物前先打码。
                        body: truncate(isCheckout ? maskCardEchoes(body) : body, 2000)
                    });
                }).catch(() => {});
            }
            // 成功那一发里可能带凭据，只记顶层字段名：够判断注册到底走没走过去，又不泄露 token。
            if (/\/api\/auth\/native\/register-completion/i.test(rawUrl) && response.status() < 400) {
                response.json().then((parsed) => {
                    write({
                        at: new Date().toISOString(),
                        kind: 'completion-keys',
                        status: response.status(),
                        url: sanitizeUrl(rawUrl),
                        keys: Object.keys(parsed || {})
                    });
                }).catch(() => {});
            }
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
    console.log(`[Muse] headful=${CONFIG.headful} proxy=${CONFIG.proxy ? 'yes' : 'no'} clickSignup=${CONFIG.clickSignup} humanize=${CONFIG.humanize ? 'on' : 'off'} account=${CONFIG.account ? maskAccount(CONFIG.account) : '<none>'}`);

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
        await humanPause(page, 900, 2200);
        await idleBrowse(page);
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
                        await clickCandidate(page, target);
                    } catch (error) {
                        console.error(`[Muse] 点击失败: ${error.message}`);
                    }

                    const popup = await popupPromise;
                    await humanPause(page, CONFIG.settleMs - 400, CONFIG.settleMs + 900);
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                    await dumpPage(page, '02-after-signup-click');
                    markProgress(80);

                    if (popup) {
                        await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.navigationTimeoutMs }).catch(() => {});
                        await humanPause(popup, 1000, 2400);
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
                        await settleAfterAction(page);
                        await dumpPage(page, '05-after-continue');
                        markProgress(82);
                        await dumpExtraPages(context, page, '05-after-continue-page');
                        markProgress(84);

                        const otpField = await findOtpField(page);
                        if (!otpField) {
                            console.log('[Muse] 第二屏没找到验证码输入框，侦察到此为止。');
                        } else {
                            console.log(`[Muse] 第二屏 ${formatOtpTarget(otpField.info)}`);
                            markProgress(86);
                            const code = await waitForInputCode(CONFIG.otpTimeoutMs);
                            if (code) {
                                const birthday = resolveBirthday();
                                // 生日屏一 mount 就会用 0 岁默认值提交，所以改写必须在提交验证码之前挂好。
                                await holdAdultBirthday(page, birthday);
                                if (await fillOtpAndSubmit(page, code)) {
                                    await settleAfterAction(page);
                                    await dumpPage(page, '06-after-otp');
                                    markProgress(94);
                                    await dumpExtraPages(context, page, '06-after-otp-page');

                                    // 成年生日是靠 holdAdultBirthday 改写请求体带过去的，UI 上那个屏我们已经
                                    // 赶不上了（它在 confirm-otp 后 2.4s 就自己提交了），这里只导出现场。
                                    // 老号登录压根没有生日屏（025224 直接落卡页），URL 没变就别再导一份一模一样的。
                                    const afterOtpUrl = page.url();
                                    await settleAfterAction(page);
                                    markProgress(98);
                                    if (page.url() !== afterOtpUrl) {
                                        await dumpPage(page, '07-after-birthday');
                                        await dumpExtraPages(context, page, '07-after-birthday-page');
                                    }

                                    // 这一屏有两种落点：新号停在 disclosure（只有 Get started 可点），
                                    // 老号登录直接落 /access/verification 的卡页（025224 就是）。
                                    // 但 disclosure 是生日屏自己提交后才异步挂出来的，验证码刚过那一瞬页面还停在
                                    // 生日屏上（075725：一次性找 Get started 找空，等 cc-number 的 20 秒里 disclosure
                                    // 才出现，结果按钮没点、卡页也没认出来）。所以两种落点都得轮询，谁先来走谁。
                                    const getStarted = page.locator('button', { hasText: 'Get started' }).first();
                                    const cardNumber = page.locator('input[autocomplete="cc-number"]').first();
                                    // 一律按「可见」判定，不能只看节点在不在：disclosure 刚挂出来那一拍，<button>
                                    // 已进文档但还没布局，count() 说有、humanClick 拿不到盒子就白点一次（一次机会
                                    // 用光，剩下 60 秒干等）。卡号框同理，旧代码 waitForSelector 等的就是可见。
                                    const isShown = (locator) => locator.isVisible().catch(() => false);
                                    const deadline = Date.now() + 60000;
                                    let clickedDisclosure = false;
                                    while (Date.now() < deadline && !(await isShown(cardNumber))) {
                                        if (!clickedDisclosure && await isShown(getStarted)) {
                                            // 只点一次：点了以后 POST /api/hatch/accept-tos 要时间换屏，
                                            // 对着还留在屏幕上的旧按钮再补一次等于重复提交。
                                            clickedDisclosure = true;
                                            console.log(await humanClick(page, getStarted)
                                                ? '[Muse] 已点 disclosure 的 Get started，等卡页。'
                                                : '[Muse] Get started 没点到，继续等卡页。');
                                        }
                                        await humanPause(page, 800, 1600);
                                    }
                                    const reachedCard = await isShown(cardNumber);
                                    const cardPageLabel = reachedCard ? '08-card-page' : '08-no-card-page';
                                    await dumpPage(page, cardPageLabel);
                                    await dumpExtraPages(context, page, cardPageLabel);
                                    if (!reachedCard) {
                                        const url = sanitizeUrl(page.url());
                                        console.log(clickedDisclosure
                                            ? `[Muse] 已点 Get started，但 60s 内没等到卡页（url=${url}），跳过绑卡。`
                                            : `[Muse] 60s 内既没出现 disclosure 的 Get started，也没出现卡页（url=${url}），跳过绑卡。`);
                                        // 后台按「退出码 0 + MUSE_DEBUG_DONE」判成功（server.js:2875），没到卡页的
                                        // 上一轮照样报绿。这行前缀是 server.js:697 认的运行时错误标记，为的是让
                                        // 任务列表直接写清卡在哪一步，不只是「子进程退出 code=1」。
                                        console.error(`❌ [运行时错误]: ${clickedDisclosure ? '点了 Get started 却没等到卡页' : '没等到 disclosure 的 Get started'}，url=${url}`);
                                        process.exitCode = 1;
                                    }
                                    await fillCardAndConfirm(page, context);
                                }
                            }
                        }
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
        markProgress(99);
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
