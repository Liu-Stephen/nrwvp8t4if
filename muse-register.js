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
    if (typed.length !== chars.length) {
        console.log(`[Muse] 逐字符输入后只剩 ${typed.length}/${chars.length} 位，改用 fill`);
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

// 生日留空时随机取 22~32 岁；日只到 28，避免造出非法日期。
function resolveBirthday() {
    const raw = CONFIG.birthday;
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
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

// 在页面上下文中执行：关掉「Something went wrong」这类模态框（没有则返回 null）。
function dismissErrorDialog() {
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
    const clean = (value, max = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

    const isCloseish = (el) => {
        if (String(el.getAttribute('aria-label') || '').toLowerCase() === 'close') return true;
        return clean(el.innerText || el.value || el.textContent, 20).toLowerCase() === 'ok';
    };
    // 「Returning to login」这类按钮的 aria-label 也是 close，点下去等于 POST /api/auth/native/restart，
    // 当前这一屏（生日下拉）会被整个换掉，所以只能认出来、不能点。
    const isNavigational = (el) => /return(ing| back)|back to|log ?in|sign ?in/i.test(clean(el.innerText || el.textContent, 40));

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => isVisible(el) && isCloseish(el));
    if (!buttons.length) return null;

    const target = buttons.find((el) => !isNavigational(el)) || buttons[0];
    const navigational = isNavigational(target);
    target.setAttribute('data-muse-dismiss', navigational ? 'nav' : '1');
    const dialog = target.closest('[role="dialog"], [role="alertdialog"]') || target.parentElement;
    return {
        label: clean(target.getAttribute('aria-label') || target.innerText || target.textContent, 30),
        text: dialog ? clean(dialog.innerText || dialog.textContent) : '',
        button: clean(target.innerText || target.textContent, 40),
        navigational
    };
}

// 在页面上下文中执行：标记生日屏的三个隐藏 select（可见的是自定义按钮，别点）和提交按钮。
function tagBirthdayFields() {
    const clean = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

    const pick = (name) => Array.from(document.querySelectorAll('select'))
        .find((el) => String(el.autocomplete || '').toLowerCase() === name) || null;

    const month = pick('bday-month');
    const day = pick('bday-day');
    const year = pick('bday-year');
    if (!month || !day || !year) return null;

    month.setAttribute('data-muse-bday', 'month');
    day.setAttribute('data-muse-bday', 'day');
    year.setAttribute('data-muse-bday', 'year');

    const info = {
        monthOptions: month.options ? month.options.length : 0,
        dayOptions: day.options ? day.options.length : 0,
        yearOptions: year.options ? year.options.length : 0,
        current: `${month.value}/${day.value}/${year.value}`,
        submit: null
    };

    const scope = month.closest('form') || document;
    const submit = Array.from(scope.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .find((el) => !el.disabled) || null;
    if (submit) {
        submit.setAttribute('data-muse-bday', 'submit');
        info.submit = {
            tag: String(submit.tagName || '').toLowerCase(),
            type: submit.getAttribute('type') || '',
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

async function dismissDialog(page) {
    for (let round = 0; round < 3; round += 1) {
        let hit = null;
        for (const frame of page.frames()) {
            try {
                const found = await frame.evaluate(dismissErrorDialog);
                if (found) {
                    hit = { frame, found };
                    break;
                }
            } catch (_) {
                // 跨域或已销毁的 frame，跳过。
            }
        }
        if (!hit) return false;
        if (hit.found.navigational) {
            console.log(`[Muse] 弹框只剩跳转按钮「${hit.found.button}」，点了会重启注册流程，留着不动`);
            return true;
        }
        console.log(`[Muse] 关掉弹框 [${hit.found.label}] ${truncate(hit.found.text, 200)}`);
        await humanPause(page, 400, 1300);
        await humanClick(page, hit.frame.locator('[data-muse-dismiss="1"]').first());
        await humanPause(page, 500, 1200);
    }
    return true;
}

async function fillBirthdayAndSubmit(page, birthday) {
    const pageFrames = page.frames();
    for (let i = 0; i < pageFrames.length; i += 1) {
        const frame = pageFrames[i];
        let info = null;
        try {
            info = await frame.evaluate(tagBirthdayFields);
        } catch (_) {
            continue;
        }
        if (!info) continue;

        console.log(`[Muse] 生日屏 frame#${i} 当前=${info.current} 选项数=${info.monthOptions}/${info.dayOptions}/${info.yearOptions}`);
        const picks = [
            ['month', String(birthday.month)],
            ['day', String(birthday.day)],
            ['year', String(birthday.year)]
        ];
        for (const [key, value] of picks) {
            try {
                const select = frame.locator(`[data-muse-bday="${key}"]`).first();
                await select.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
                // 只改 DOM 的 value，React 的 value tracker 会认为值没变、onChange 不跑，
                // 提交时拿到的还是 state 里的默认值。用原生 setter 绕过它自己的描述符再派发事件。
                const changed = await select.evaluate((el, next) => {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                    setter.call(el, next);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return String(el.value || '');
                }, value);
                if (changed !== value) {
                    throw new Error(`回读=${changed || '<空>'}`);
                }
                await humanPause(page, 260, 900);
            } catch (error) {
                console.error(`[Muse] 选择 ${key}=${value} 失败: ${error.message}`);
                return false;
            }
        }
        const after = await frame.evaluate(() => {
            const pick = (name) => Array.from(document.querySelectorAll('select'))
                .find((el) => String(el.autocomplete || '').toLowerCase() === name);
            // 页面上那三个自定义按钮（October/26/2026）的文案是 state 渲染出来的，
            // select.value 只能证明 DOM，这一行才能证明 onChange 真的跑进了 state。
            const display = (el) => {
                if (!el) return '?';
                const names = Array.from(el.options).map((o) => String(o.textContent || '').trim());
                let node = el.parentElement;
                for (let depth = 0; node && depth < 4; depth += 1) {
                    const btn = Array.from(node.querySelectorAll('button'))
                        .find((b) => names.includes(String(b.textContent || '').trim()));
                    if (btn) return String(btn.textContent || '').trim();
                    node = node.parentElement;
                }
                return '<没找到触发按钮>';
            };
            const month = pick('bday-month');
            const day = pick('bday-day');
            const year = pick('bday-year');
            if (!month || !day || !year) return '';
            return `${month.value}/${day.value}/${year.value} 显示=${display(month)}/${display(day)}/${display(year)}`;
        }).catch(() => '');
        console.log(`[Muse] 生日已选 ${birthday.year}-${birthday.month}-${birthday.day}（${birthday.source}）选中后=${after || '<未知>'}`);
        markProgress(96);

        const submit = frame.locator('[data-muse-bday="submit"]').first();
        try {
            if (!(await submit.count())) {
                console.log('[Muse] 生日屏没有提交按钮，保留现场不回车。');
                return true;
            }
            await humanPause(page, 700, 2000);
            if (await humanClick(page, submit)) {
                return true;
            }
            // 点到这一步失败基本都是 403 弹框（fixed w-full）盖住了按钮，关掉非导航的那层再点一次。
            console.log('[Muse] 生日提交第一次没点到，先看是不是被弹框盖住');
            if (await dismissDialog(page)) {
                await humanPause(page, 400, 1200);
                if (await humanClick(page, submit)) {
                    return true;
                }
            }
            // 这里绝不能用回车兜底：实测回车发出的是 restart 201，整屏会被换回首页。
            console.log('[Muse] 生日提交按钮仍然点不到，保留现场，不回车。');
            return true;
        } catch (error) {
            console.error(`[Muse] 生日提交失败: ${error.message}`);
            return false;
        }
    }
    return false;
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

    // 生日到底以什么字段发出去我们从来没见过，请求体先存一份（邮箱打码）。
    context.on('request', (request) => {
        try {
            const rawUrl = request.url();
            if (!/\/api\/auth\/native\/(register-completion|confirm-otp)/i.test(rawUrl)) return;
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
            // 注册链路上的报错全靠这个，否则 403 只能看到状态码。
            if (response.status() >= 400 && /\/api\/auth\/native\//i.test(rawUrl)) {
                response.text().then((body) => {
                    write({
                        at: new Date().toISOString(),
                        method: request.method(),
                        type,
                        status: response.status(),
                        url: sanitizeUrl(rawUrl),
                        body: truncate(body, 2000)
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
                            if (code && await fillOtpAndSubmit(page, code)) {
                                await settleAfterAction(page);
                                await dumpPage(page, '06-after-otp');
                                markProgress(94);
                                await dumpExtraPages(context, page, '06-after-otp-page');

                                // 这一屏一渲染就拿着默认值（今天，0 岁）自己提交了一次 register-completion，
                                // 而弹框一点（尤其「Returning to login」）整个流程就 restart、下拉框全消失，
                                // 所以必须趁表单还活着先把生日选掉，弹框放到之后再处理。
                                const birthday = resolveBirthday();
                                let birthdayDone = await fillBirthdayAndSubmit(page, birthday);
                                if (!birthdayDone) {
                                    console.log('[Muse] 这一屏没有 bday-* 生日下拉，先关弹框再找一次。');
                                    await dismissDialog(page);
                                    birthdayDone = await fillBirthdayAndSubmit(page, birthday);
                                }
                                if (birthdayDone) {
                                    await settleAfterAction(page);
                                    await dumpPage(page, '07-after-birthday');
                                    markProgress(98);
                                    await dumpExtraPages(context, page, '07-after-birthday-page');
                                } else {
                                    console.log('[Muse] 关掉弹框后还是没有生日下拉，侦察到此为止。');
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
