/*
 * Lore Tidy — SillyTavern UI extension
 *
 * Shows where every lorebook is used (character primary / extra books, persona,
 * Global, chat lore of every character chat), finds lorebooks nobody uses any
 * more, and deletes them in bulk — always offering a .zip backup first.
 * Also cleans up leftovers of the WorldInfoPlus extension.
 */

import {
    world_names,
    selected_world_info,
    world_info,
    deleteWorldInfo,
    openWorldInfoEditor,
    loadWorldInfo,
} from '../../../world-info.js';

const MODULE = 'lore_tidy';
const LOG = '[LoreTidy]';
const WIP_MODULE = 'world-info-plus';
const SCAN_CONCURRENCY = 3;

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------- helpers

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fileStamp(ts = Date.now()) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}h${p(d.getMinutes())}m`;
}

function safeFileName(s) {
    return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'lorebook';
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const toast = {
    ok: m => globalThis.toastr?.success(m, 'Lore Tidy'),
    info: m => globalThis.toastr?.info(m, 'Lore Tidy'),
    warn: m => globalThis.toastr?.warning(m, 'Lore Tidy'),
    err: m => globalThis.toastr?.error(m, 'Lore Tidy'),
};

const bookNames = () => (Array.isArray(world_names) ? [...world_names] : []);
const avatarStem = avatar => String(avatar ?? '').replace(/\.[^/.]+$/, '');
const thumbUrl = avatar => `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });

function wipSettings() {
    const s = ctx().extensionSettings?.[WIP_MODULE];
    return s && typeof s === 'object' ? s : null;
}

// ---------------------------------------------------------------- tiny ZIP writer (store, no compression)

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** @param {{name: string, data: Uint8Array}[]} files */
export function makeZip(files, now = new Date()) {
    const enc = new TextEncoder();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const crc = crc32(f.data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(6, 0x0800, true); // UTF-8 file names
        lh.setUint16(8, 0, true);
        lh.setUint16(10, time, true);
        lh.setUint16(12, date, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, f.data.length, true);
        lh.setUint32(22, f.data.length, true);
        lh.setUint16(26, name.length, true);
        parts.push(new Uint8Array(lh.buffer), name, f.data);

        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true);
        ch.setUint16(12, time, true);
        ch.setUint16(14, date, true);
        ch.setUint32(16, crc, true);
        ch.setUint32(20, f.data.length, true);
        ch.setUint32(24, f.data.length, true);
        ch.setUint16(28, name.length, true);
        ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** Download the given lorebooks as one .zip (one importable .json per book). Throws if any book can't be read. */
async function backupBooks(names) {
    const enc = new TextEncoder();
    const used = new Set();
    const files = [];
    for (const n of names) {
        const data = await loadWorldInfo(n);
        if (!data) throw new Error(`อ่านเล่ม "${n}" จากเซิร์ฟเวอร์ไม่ได้ เลยยังไม่ลบอะไร`);
        let base = safeFileName(n);
        let fname = `${base}.json`;
        for (let i = 2; used.has(fname.toLowerCase()); i++) fname = `${base} (${i}).json`;
        used.add(fname.toLowerCase());
        files.push({ name: fname, data: enc.encode(JSON.stringify(data, null, 4)) });
    }
    downloadBlob(makeZip(files), `lorebooks-backup ${fileStamp()}.zip`);
}

// ---------------------------------------------------------------- usage model

/**
 * @typedef {{name: string, avatar: string}} CharRef
 * @typedef {{
 *   global: boolean,
 *   chars: {char: CharRef, kind: 'primary'|'extra'}[],
 *   personas: string[],
 *   chats: {char: CharRef|null, file: string}[],
 *   wip: {chatId: string, char: CharRef|null}[],
 * }} Usage
 */

/** Result of scanning every character chat's metadata. Kept for the session. */
let chatScan = {
    state: 'idle',          // idle | running | done | error
    progress: [0, 0],
    at: 0,
    chatCount: 0,
    failed: 0,
    /** @type {{book: string, char: CharRef, file: string}[]} */
    links: [],
    /** @type {Map<string, CharRef>} chat file id -> character */
    fileToChar: new Map(),
};
let scanPromise = null;
/** Set when chats or characters may have changed since the last scan; the next open rescans. */
let scanDirty = false;

function characterList() {
    return (ctx().characters || []).filter(ch => ch && ch.avatar);
}

async function scanChats(onProgress) {
    if (scanPromise) return scanPromise;
    const chars = characterList();
    if (!chars.length) {
        // Character list not loaded yet (or really empty): never report "done" on nothing.
        chatScan.state = 'nochars';
        onProgress?.();
        return;
    }
    chatScan = { state: 'running', progress: [0, chars.length], at: 0, chatCount: 0, failed: 0, links: [], fileToChar: new Map() };
    scanDirty = false;
    const headers = ctx().getRequestHeaders();

    scanPromise = (async () => {
        let next = 0;
        const worker = async () => {
            while (next < chars.length) {
                const ch = chars[next++];
                const ref = { name: ch.name, avatar: ch.avatar };
                try {
                    const res = await fetch('/api/characters/chats', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ avatar_url: ch.avatar, metadata: true }),
                    });
                    if (!res.ok) throw new Error(String(res.status));
                    const list = await res.json();
                    if (Array.isArray(list)) {
                        for (const chat of list) {
                            const file = String(chat.file_id ?? chat.file_name ?? '').replace(/\.jsonl$/, '');
                            if (!file) continue;
                            chatScan.chatCount++;
                            chatScan.fileToChar.set(file, ref);
                            const book = chat.chat_metadata?.world_info;
                            if (typeof book === 'string' && book) chatScan.links.push({ book, char: ref, file });
                        }
                    }
                } catch (e) {
                    chatScan.failed++;
                    console.warn(LOG, 'chat scan failed for', ch.avatar, e);
                }
                chatScan.progress[0]++;
                onProgress?.();
            }
        };
        await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
        chatScan.state = 'done';
        chatScan.at = Date.now();
    })().catch(e => {
        console.error(LOG, e);
        chatScan.state = 'error';
    }).finally(() => {
        scanPromise = null;
        onProgress?.();
    });
    return scanPromise;
}

function buildModel() {
    const c = ctx();
    const names = bookNames();
    const exists = new Set(names);
    /** @type {Map<string, Usage>} */
    const usage = new Map(names.map(n => [n, { global: false, chars: [], personas: [], chats: [], wip: [] }]));
    /** @type {{book: string, where: string, fix?: {type: 'extra', stem: string}}[]} */
    const missing = [];
    const touch = (book, where, fix) => {
        if (usage.has(book)) return usage.get(book);
        missing.push({ book, where, fix });
        return null;
    };

    for (const n of selected_world_info || []) {
        const u = touch(n, 'Global');
        if (u) u.global = true;
    }

    const chars = characterList();
    const stemToChar = new Map();
    for (const ch of chars) {
        const ref = { name: ch.name, avatar: ch.avatar };
        stemToChar.set(avatarStem(ch.avatar), ref);
        const primary = ch.data?.extensions?.world;
        if (primary) touch(primary, `การ์ด ${ch.name} (เล่มหลัก)`)?.chars.push({ char: ref, kind: 'primary' });
    }

    /** charLore entries whose character no longer exists */
    const staleCharLore = [];
    for (const entry of world_info?.charLore ?? []) {
        const ref = stemToChar.get(entry?.name);
        if (!ref) {
            staleCharLore.push(entry);
            continue;
        }
        for (const b of entry.extraBooks ?? []) {
            touch(b, `การ์ด ${ref.name} (เล่มเสริม)`, { type: 'extra', stem: entry.name })?.chars.push({ char: ref, kind: 'extra' });
        }
    }

    const pu = c.powerUserSettings ?? {};
    for (const [avatar, desc] of Object.entries(pu.persona_descriptions ?? {})) {
        const book = desc?.lorebook;
        if (!book) continue;
        const pname = pu.personas?.[avatar] || avatar;
        touch(book, `Persona ${pname}`)?.personas.push(pname);
    }

    // Chat lore: every character chat (from the scan) + the chat open right now (live, may be unsaved).
    const currentId = c.chatId ? String(c.chatId) : null;
    const currentRef = c.characterId !== undefined && c.characterId !== null && c.characters?.[c.characterId]
        ? { name: c.characters[c.characterId].name, avatar: c.characters[c.characterId].avatar }
        : null;
    for (const l of chatScan.links) {
        if (l.file === currentId) continue;
        touch(l.book, `แชท ${l.char.name} — ${l.file}`)?.chats.push({ char: l.char, file: l.file });
    }
    const liveBook = c.chatMetadata?.world_info;
    if (currentId && typeof liveBook === 'string' && liveBook) {
        touch(liveBook, `แชทที่เปิดอยู่ (${currentId})`)?.chats.push({ char: currentRef, file: currentId });
    }

    // WorldInfoPlus "multi chat lore" links (kept in settings even after WIP is removed).
    const wip = wipSettings();
    for (const [chatId, books] of Object.entries(wip?.chatLorebooks ?? {})) {
        if (!Array.isArray(books)) continue;
        const char = chatScan.fileToChar.get(chatId) ?? (chatId === currentId ? currentRef : null);
        for (const b of books) usage.get(b)?.wip.push({ chatId, char });
    }

    return { names, exists, usage, missing, staleCharLore };
}

function isUnused(u) {
    return !u.global && !u.chars.length && !u.personas.length && !u.chats.length && !u.wip.length;
}

// ---------------------------------------------------------------- UI state

const ui = {
    tab: 'unused',     // all | unused | bychar | tools
    query: '',
    /** @type {Set<string>} */
    selected: new Set(),
    confirm: null,     // null | { names: string[] }
    busy: false,
    /** @type {ReturnType<typeof buildModel>|null} */
    model: null,
};

// ---------------------------------------------------------------- modal

function openModal() {
    const old = document.getElementById('lt_modal');
    if (old) old._ltClose?.();

    const wrap = document.createElement('div');
    wrap.id = 'lt_modal';
    wrap.innerHTML = `
        <div class="lt_dialog" role="dialog" aria-label="Lore Tidy">
            <div class="lt_head">
                <b class="lt_title"><i class="fa-solid fa-broom"></i> Lore Tidy</b>
                <input id="lt_search" class="text_pole" type="search" placeholder="ค้นหาชื่อเล่ม / การ์ด">
                <div class="lt_close menu_button fa-solid fa-xmark" title="ปิด"></div>
            </div>
            <div class="lt_tabs" role="tablist"></div>
            <div class="lt_status"></div>
            <div class="lt_body"></div>
            <div class="lt_foot"></div>
        </div>`;
    document.body.appendChild(wrap);

    const vv = window.visualViewport;
    const fit = () => {
        wrap.style.top = `${vv ? vv.offsetTop : 0}px`;
        wrap.style.left = `${vv ? vv.offsetLeft : 0}px`;
        wrap.style.width = `${vv ? vv.width : window.innerWidth}px`;
        wrap.style.height = `${vv ? vv.height : window.innerHeight}px`;
    };
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    const onKey = e => { if (e.key === 'Escape' && !ui.busy) close(); };
    document.addEventListener('keydown', onKey);
    function close() {
        vv?.removeEventListener('resize', fit);
        vv?.removeEventListener('scroll', fit);
        window.removeEventListener('resize', fit);
        document.removeEventListener('keydown', onKey);
        wrap.remove();
    }
    wrap._ltClose = close;
    wrap.addEventListener('click', e => { if (e.target === wrap && !ui.busy) close(); });
    wrap.querySelector('.lt_close').addEventListener('click', () => { if (!ui.busy) close(); });

    const search = wrap.querySelector('#lt_search');
    search.value = ui.query;
    search.addEventListener('input', () => { ui.query = search.value; renderBody(); });

    ui.confirm = null;
    refresh();
    if (chatScan.state !== 'running' && (chatScan.state !== 'done' || scanDirty)) startScan();
}

function startScan() {
    let pending = false;
    const tick = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; refresh(); });
    };
    scanChats(tick);
    refresh();
}

function refresh() {
    if (!document.getElementById('lt_modal')) return;
    ui.model = buildModel();
    // drop selections of books that no longer exist
    for (const n of [...ui.selected]) if (!ui.model.exists.has(n)) ui.selected.delete(n);
    renderTabs();
    renderStatus();
    renderBody();
    renderFoot();
}

function renderTabs() {
    const wrap = document.getElementById('lt_modal');
    const m = ui.model;
    const unused = m.names.filter(n => isUnused(m.usage.get(n))).length;
    const issues = m.missing.length + (characterList().length ? m.staleCharLore.length : 0) + wipLeftoversInGlobal(m).length;
    const tabs = [
        ['unused', `ไม่มีใครใช้ (${unused})`],
        ['bychar', 'ตามการ์ด'],
        ['all', `ทั้งหมด (${m.names.length})`],
        ['tools', `ลิงก์ค้าง${issues ? ` (${issues})` : ''}`],
    ];
    const el = wrap.querySelector('.lt_tabs');
    el.innerHTML = tabs.map(([k, label]) =>
        `<div class="lt_tab menu_button ${ui.tab === k ? 'lt_active' : ''}" role="tab" data-tab="${k}">${escapeHtml(label)}</div>`).join('');
    el.querySelectorAll('.lt_tab').forEach(t => t.addEventListener('click', () => {
        ui.tab = t.dataset.tab;
        renderTabs();
        renderBody();
    }));
}

function renderStatus() {
    const el = document.querySelector('#lt_modal .lt_status');
    if (!el) return;
    const s = chatScan;
    let html;
    if (s.state === 'running') {
        html = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังเช็ค Chat Lore ในแชทของทุกการ์ด… ${s.progress[0]}/${s.progress[1]} การ์ด
                <span class="lt_dim">(ระหว่างนี้ยังไม่นับเล่มที่ผูกกับแชทอื่น ยังไม่ควรลบ)</span>`;
    } else if (s.state === 'done') {
        html = `<i class="fa-solid fa-check"></i> เช็คแชทแล้ว ${s.chatCount} แชท จาก ${s.progress[1]} การ์ด`
            + (s.failed ? ` <span class="lt_warn">· อ่านไม่ได้ ${s.failed} การ์ด</span>` : '')
            + ` <span class="lt_dim">· ไม่รวมแชทกลุ่ม</span>`
            + ` <span class="lt_link" id="lt_rescan">สแกนใหม่</span>`;
    } else if (s.state === 'nochars') {
        html = `<span class="lt_warn"><i class="fa-solid fa-triangle-exclamation"></i> ยังไม่มีรายชื่อการ์ด (SillyTavern อาจยังโหลดไม่เสร็จ) ตอนนี้ยังบอกไม่ได้ว่าเล่มไหนไม่มีใครใช้ ลบไม่ได้จนกว่าจะเช็คเสร็จ</span> <span class="lt_link" id="lt_rescan">ลองใหม่</span>`;
    } else if (s.state === 'error') {
        html = `<span class="lt_warn"><i class="fa-solid fa-triangle-exclamation"></i> เช็คแชทไม่สำเร็จ</span> <span class="lt_link" id="lt_rescan">ลองใหม่</span>`;
    } else {
        html = '';
    }
    el.innerHTML = html;
    el.querySelector('#lt_rescan')?.addEventListener('click', startScan);
}

function matchesQuery(name, u) {
    const q = ui.query.trim().toLowerCase();
    if (!q) return true;
    if (name.toLowerCase().includes(q)) return true;
    return u.chars.some(x => x.char.name.toLowerCase().includes(q));
}

function badgesHtml(u) {
    const out = [];
    if (u.global) out.push('<span class="lt_badge lt_b_global" title="เปิดไว้ใน Global World Info"><i class="fa-solid fa-globe"></i> Global</span>');
    const primary = u.chars.filter(x => x.kind === 'primary');
    const extra = u.chars.filter(x => x.kind === 'extra');
    const charBadge = (list, label) => {
        if (!list.length) return;
        const names = list.map(x => x.char.name);
        const text = names.length <= 2 ? names.join(', ') : `${names.length} การ์ด`;
        out.push(`<span class="lt_badge lt_b_char" title="${escapeHtml(`${label}: ${names.join(', ')}`)}"><i class="fa-solid fa-user"></i> ${escapeHtml(label)}: ${escapeHtml(text)}</span>`);
    };
    charBadge(primary, 'เล่มหลัก');
    charBadge(extra, 'เล่มเสริม');
    if (u.personas.length) {
        out.push(`<span class="lt_badge lt_b_persona" title="${escapeHtml(u.personas.join(', '))}"><i class="fa-solid fa-masks-theater"></i> Persona: ${escapeHtml(u.personas.length <= 2 ? u.personas.join(', ') : `${u.personas.length} ตัว`)}</span>`);
    }
    if (u.chats.length) {
        const tip = u.chats.map(x => `${x.char?.name ?? '?'} — ${x.file}`).join('\n');
        out.push(`<span class="lt_badge lt_b_chat" title="${escapeHtml(tip)}"><i class="fa-solid fa-comments"></i> Chat Lore ${u.chats.length} แชท</span>`);
    }
    if (u.wip.length) {
        const tip = u.wip.map(x => `${x.char?.name ?? '?'} — ${x.chatId}`).join('\n');
        out.push(`<span class="lt_badge lt_b_wip" title="${escapeHtml(`ผูกผ่าน WorldInfoPlus:\n${tip}`)}"><i class="fa-solid fa-puzzle-piece"></i> WIP ${u.wip.length} แชท</span>`);
    }
    if (!out.length) out.push('<span class="lt_badge lt_b_unused"><i class="fa-regular fa-circle"></i> ไม่มีใครใช้</span>');
    return out.join('');
}

function rowHtml(name, u, note = '') {
    const checked = ui.selected.has(name) ? 'checked' : '';
    return `
        <div class="lt_row ${isUnused(u) ? 'lt_unused' : ''}" data-book="${escapeHtml(name)}">
            <input type="checkbox" class="lt_cb" ${checked} aria-label="เลือก ${escapeHtml(name)}">
            <div class="lt_main">
                <div class="lt_name">${escapeHtml(name)}${note ? ` <span class="lt_note">${escapeHtml(note)}</span>` : ''}</div>
                <div class="lt_badges">${badgesHtml(u)}</div>
            </div>
            <div class="lt_acts">
                <div class="menu_button lt_open fa-solid fa-pen-to-square" title="เปิดในตัวแก้ไข"></div>
            </div>
        </div>`;
}

function groupHtml(key, title, books, { avatar = null, sub = '' } = {}) {
    const allSel = books.length && books.every(b => ui.selected.has(b.name));
    return `
        <div class="lt_group" data-group="${escapeHtml(key)}">
            <div class="lt_group_head">
                <input type="checkbox" class="lt_gcb" ${allSel ? 'checked' : ''} title="เลือกทั้งกลุ่ม">
                ${avatar ? `<img class="lt_avatar" src="${escapeHtml(thumbUrl(avatar))}" alt="" loading="lazy">` : ''}
                <div class="lt_group_title">${escapeHtml(title)} <span class="lt_dim">${books.length} เล่ม${sub ? ` · ${escapeHtml(sub)}` : ''}</span></div>
            </div>
            ${books.map(b => rowHtml(b.name, b.u, b.note)).join('')}
        </div>`;
}

function renderBody() {
    const body = document.querySelector('#lt_modal .lt_body');
    if (!body) return;
    const m = ui.model;
    const sorted = [...m.names].sort(collator.compare);
    let html = '';

    if (ui.tab === 'tools') {
        html = toolsHtml(m);
    } else if (ui.tab === 'bychar') {
        /** @type {Map<string, {ref: CharRef, books: {name: string, u: Usage, note: string}[]}>} */
        const groups = new Map();
        const loose = [];
        for (const name of sorted) {
            const u = m.usage.get(name);
            if (!matchesQuery(name, u)) continue;
            const refs = new Map();
            for (const x of u.chars) refs.set(x.char.avatar, { ref: x.char, note: x.kind === 'primary' ? 'เล่มหลัก' : 'เล่มเสริม' });
            for (const x of u.chats) if (x.char && !refs.has(x.char.avatar)) refs.set(x.char.avatar, { ref: x.char, note: 'Chat Lore' });
            for (const x of u.wip) if (x.char && !refs.has(x.char.avatar)) refs.set(x.char.avatar, { ref: x.char, note: 'WIP' });
            if (!refs.size) { loose.push({ name, u, note: '' }); continue; }
            for (const { ref, note } of refs.values()) {
                if (!groups.has(ref.avatar)) groups.set(ref.avatar, { ref, books: [] });
                groups.get(ref.avatar).books.push({ name, u, note });
            }
        }
        const list = [...groups.values()].sort((a, b) => collator.compare(a.ref.name, b.ref.name));
        html = list.map(g => groupHtml(`c:${g.ref.avatar}`, g.ref.name, g.books, { avatar: g.ref.avatar })).join('');
        if (loose.length) {
            html += groupHtml('loose', 'ไม่ผูกกับการ์ดไหน', loose, { sub: 'รวมเล่ม Global / Persona และเล่มที่ไม่มีใครใช้' });
        }
        if (!html) html = '<div class="lt_empty">ไม่พบเล่มที่ตรงกับคำค้น</div>';
    } else {
        const rows = sorted
            .map(name => ({ name, u: m.usage.get(name) }))
            .filter(({ name, u }) => (ui.tab === 'all' || isUnused(u)) && matchesQuery(name, u));
        if (!rows.length) {
            html = ui.tab === 'unused' && !ui.query
                ? '<div class="lt_empty">ไม่มีเล่มที่ไม่มีใครใช้ 🎉</div>'
                : '<div class="lt_empty">ไม่พบเล่มที่ตรงกับคำค้น</div>';
        } else {
            const allSel = rows.every(r => ui.selected.has(r.name));
            html = `<div class="lt_listhead"><label class="checkbox_label"><input type="checkbox" class="lt_allcb" ${allSel ? 'checked' : ''}> เลือกทั้งหมดที่แสดง (${rows.length})</label></div>`
                + rows.map(r => rowHtml(r.name, r.u)).join('');
            if (ui.tab === 'unused' && chatScan.state !== 'done') {
                html = `<div class="lt_banner lt_warn">ยังเช็คไม่เสร็จ เล่มในรายการนี้อาจยังมีการ์ดหรือแชทใช้อยู่</div>` + html;
            }
        }
    }

    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;
    wireBody(body);
}

function wireBody(body) {
    body.querySelectorAll('.lt_row').forEach(row => {
        const name = row.dataset.book;
        const cb = row.querySelector('.lt_cb');
        cb.addEventListener('change', () => { toggleSel([name], cb.checked); });
        row.querySelector('.lt_main').addEventListener('click', () => { toggleSel([name], !ui.selected.has(name)); });
        row.querySelector('.lt_open').addEventListener('click', () => {
            document.getElementById('lt_modal')?._ltClose?.();
            openWorldInfoEditor(name);
        });
    });
    body.querySelectorAll('.lt_group').forEach(g => {
        const names = [...g.querySelectorAll('.lt_row')].map(r => r.dataset.book);
        g.querySelector('.lt_gcb').addEventListener('change', e => toggleSel(names, e.target.checked));
    });
    body.querySelector('.lt_allcb')?.addEventListener('change', e => {
        const names = [...body.querySelectorAll('.lt_row')].map(r => r.dataset.book);
        toggleSel(names, e.target.checked);
    });
    wireTools(body);
}

function toggleSel(names, on) {
    for (const n of names) on ? ui.selected.add(n) : ui.selected.delete(n);
    ui.confirm = null;
    renderBody();
    renderFoot();
}

// ---------------------------------------------------------------- footer: backup / delete

function renderFoot() {
    const foot = document.querySelector('#lt_modal .lt_foot');
    if (!foot) return;
    const m = ui.model;
    const sel = [...ui.selected].sort(collator.compare);

    if (ui.confirm) {
        const inUse = sel.filter(n => !isUnused(m.usage.get(n)));
        foot.innerHTML = `
            <div class="lt_confirm">
                <div><b>ลบ ${sel.length} เล่ม?</b> ลบแล้วกู้คืนจากเซิร์ฟเวอร์ไม่ได้</div>
                <div class="lt_confirm_list">${sel.map(escapeHtml).join(' · ')}</div>
                ${inUse.length ? `<div class="lt_warn"><i class="fa-solid fa-triangle-exclamation"></i> ${inUse.length} เล่มยังมีคนใช้อยู่: ${inUse.map(escapeHtml).join(', ')} การ์ด แชท หรือ persona ที่ใช้อยู่จะไม่มีเล่มนี้แล้ว</div>` : ''}
                <label class="checkbox_label"><input type="checkbox" id="lt_do_backup" checked> ดาวน์โหลดไฟล์สำรอง (.zip) ก่อนลบ</label>
                <div class="lt_btns">
                    <div class="menu_button lt_cancel">ยกเลิก</div>
                    <div class="menu_button redWarningBG lt_go"><i class="fa-solid fa-trash-can"></i> ลบ ${sel.length} เล่ม</div>
                </div>
            </div>`;
        foot.querySelector('.lt_cancel').addEventListener('click', () => { ui.confirm = null; renderFoot(); });
        foot.querySelector('.lt_go').addEventListener('click', () => doDelete(sel, foot.querySelector('#lt_do_backup').checked));
        return;
    }

    foot.innerHTML = `
        <div class="lt_selinfo">เลือกไว้ ${sel.length} เล่ม${sel.length ? ' <span class="lt_link lt_clear">ล้าง</span>' : ''}</div>
        <div class="lt_btns">
            <div class="menu_button lt_backup ${sel.length ? '' : 'disabled'}" title="ดาวน์โหลดเล่มที่เลือกเป็น .zip (ใน zip มีไฟล์ .json แยกเล่ม นำเข้าใหม่ด้วยปุ่ม Import ได้)"><i class="fa-solid fa-file-zipper"></i> สำรอง</div>
            <div class="menu_button redWarningBG lt_delete ${sel.length ? '' : 'disabled'}"><i class="fa-solid fa-trash-can"></i> ลบ</div>
        </div>`;
    foot.querySelector('.lt_clear')?.addEventListener('click', () => toggleSel([...ui.selected], false));
    foot.querySelector('.lt_backup').addEventListener('click', async () => {
        if (!sel.length || ui.busy) return;
        await busy(async () => { await backupBooks(sel); toast.ok(`สำรอง ${sel.length} เล่มแล้ว`); });
    });
    foot.querySelector('.lt_delete').addEventListener('click', () => {
        if (!sel.length || ui.busy) return;
        if (chatScan.state !== 'done') {
            toast.warn(chatScan.state === 'running' ? 'รอเช็คแชทให้เสร็จก่อน แล้วค่อยลบ' : 'ยังเช็คการใช้งานไม่สำเร็จ กด "ลองใหม่" ที่แถบสถานะก่อน');
            return;
        }
        ui.confirm = { names: sel };
        renderFoot();
    });
}

async function busy(fn) {
    ui.busy = true;
    document.getElementById('lt_modal')?.classList.add('lt_busy');
    try {
        await fn();
    } catch (e) {
        console.error(LOG, e);
        toast.err(String(e?.message ?? e));
    } finally {
        ui.busy = false;
        document.getElementById('lt_modal')?.classList.remove('lt_busy');
    }
}

/** Remove references to a deleted book that SillyTavern's own delete leaves behind. */
function cleanupRefs(name) {
    let changed = false;
    const charLore = world_info?.charLore;
    if (Array.isArray(charLore)) {
        for (let i = charLore.length - 1; i >= 0; i--) {
            const e = charLore[i];
            if (!e?.extraBooks?.includes(name)) continue;
            e.extraBooks = e.extraBooks.filter(b => b !== name);
            if (!e.extraBooks.length) charLore.splice(i, 1);
            changed = true;
        }
    }
    const wip = wipSettings();
    for (const [id, list] of Object.entries(wip?.chatLorebooks ?? {})) {
        if (Array.isArray(list) && list.includes(name)) {
            wip.chatLorebooks[id] = list.filter(b => b !== name);
            changed = true;
        }
    }
    if (Array.isArray(wip?.injectedGlobal) && wip.injectedGlobal.includes(name)) {
        wip.injectedGlobal = wip.injectedGlobal.filter(b => b !== name);
        changed = true;
    }
    const c = ctx();
    if (c.chatMetadata?.world_info === name) {
        c.chatMetadata.world_info = '';
        c.saveMetadataDebounced?.();
    }
    return changed;
}

async function doDelete(names, withBackup) {
    await busy(async () => {
        if (withBackup) await backupBooks(names);
        const done = [];
        const failed = [];
        for (const n of names) {
            let ok = false;
            try { ok = await deleteWorldInfo(n); } catch (e) { console.error(LOG, e); }
            if (ok) {
                cleanupRefs(n);
                done.push(n);
            } else {
                failed.push(n);
            }
        }
        ctx().saveSettingsDebounced();
        for (const n of done) ui.selected.delete(n);
        ui.confirm = null;
        if (done.length) toast.ok(`ลบแล้ว ${done.length} เล่ม`);
        if (failed.length) toast.err(`ลบไม่สำเร็จ: ${failed.join(', ')}`);
    });
    refresh();
}

// ---------------------------------------------------------------- tools tab (dangling links, WIP leftovers)

/** Books sitting in Global only because WorldInfoPlus injected them for chat lore. */
function wipLeftoversInGlobal(m) {
    const wip = wipSettings();
    if (!wip?.chatLorebooks) return [];
    const wipBooks = new Set(Object.values(wip.chatLorebooks).flat());
    return (selected_world_info || []).filter(n => wipBooks.has(n) && m.exists.has(n));
}

function toolsHtml(m) {
    const parts = [];
    const c = ctx();

    // 1) WIP leftovers in Global
    const leftovers = wipLeftoversInGlobal(m);
    if (leftovers.length) {
        parts.push(`
            <div class="lt_card">
                <div class="lt_card_title"><i class="fa-solid fa-puzzle-piece"></i> เล่มที่ WorldInfoPlus ค้างไว้ใน Global</div>
                <div class="lt_dim">เล่มเหล่านี้เคยผูกเป็น Chat Lore ผ่าน WorldInfoPlus และตอนนี้เปิดอยู่ใน Global ถ้าไม่ได้ตั้งใจเปิดเป็น Global เอง ให้ถอดออก</div>
                ${leftovers.map(n => `<label class="checkbox_label"><input type="checkbox" class="lt_wipg" value="${escapeHtml(n)}" checked> ${escapeHtml(n)}</label>`).join('')}
                <div class="lt_btns"><div class="menu_button" id="lt_wip_unglobal"><i class="fa-solid fa-globe"></i> ถอดที่เลือกออกจาก Global</div></div>
            </div>`);
    }

    // 2) WIP links of the chat that's open
    const wip = wipSettings();
    const curId = c.chatId ? String(c.chatId) : null;
    const curWip = curId ? (wip?.chatLorebooks?.[curId] ?? []).filter(b => m.exists.has(b)) : [];
    if (curWip.length) {
        const native = c.chatMetadata?.world_info;
        parts.push(`
            <div class="lt_card">
                <div class="lt_card_title"><i class="fa-solid fa-comments"></i> แชทที่เปิดอยู่เคยผูกผ่าน WorldInfoPlus</div>
                <div class="lt_dim">Chat Lore ของ SillyTavern ผูกได้แชทละ 1 เล่ม ${native ? `ตอนนี้ผูก <b>${escapeHtml(native)}</b> อยู่` : 'ตอนนี้แชทนี้ยังไม่มี Chat Lore'} เลือกเล่มที่จะใช้เป็น Chat Lore</div>
                ${curWip.map((n, i) => `<label class="checkbox_label"><input type="radio" name="lt_wipchat" value="${escapeHtml(n)}" ${(native ? n === native : i === 0) ? 'checked' : ''}> ${escapeHtml(n)}</label>`).join('')}
                ${curWip.length > 1 ? '<div class="lt_dim">เล่มที่เหลือ ถ้าอยากให้ใช้ทุกแชทของการ์ดนี้ ให้เพิ่มเป็นเล่มเสริม (Additional Lorebooks) ของการ์ดแทน</div>' : ''}
                <div class="lt_btns"><div class="menu_button" id="lt_wip_bind"><i class="fa-solid fa-link"></i> ผูกเป็น Chat Lore ของแชทนี้</div></div>
            </div>`);
    }

    // 3) all WIP chat links (so they can be redone by hand)
    const wipEntries = Object.entries(wip?.chatLorebooks ?? {}).filter(([, l]) => Array.isArray(l) && l.length);
    if (wipEntries.length) {
        const rows = wipEntries.map(([id, list]) => {
            const ch = chatScan.fileToChar.get(id);
            return `<div class="lt_mini"><b>${escapeHtml(ch?.name ?? '?')}</b> — ${escapeHtml(id)}<br><span class="lt_dim">${list.map(escapeHtml).join(', ')}</span></div>`;
        }).join('');
        parts.push(`
            <div class="lt_card">
                <details>
                    <summary class="lt_card_title"><i class="fa-solid fa-list"></i> แชทที่ผูกผ่าน WorldInfoPlus (${wipEntries.length} แชท)</summary>
                    <div class="lt_dim">ข้อมูลนี้ยังอยู่ในการตั้งค่า แม้จะถอน WorldInfoPlus ไปแล้ว เปิดแชทไหนแล้วกลับมาที่แท็บนี้ จะผูกเป็น Chat Lore ได้${chatScan.state === 'done' ? '' : ' (ชื่อการ์ดจะขึ้นเมื่อเช็คแชทเสร็จ)'}</div>
                    ${rows}
                    <div class="lt_btns"><div class="menu_button" id="lt_wip_forget" title="ลบข้อมูลการผูกของ WorldInfoPlus ออกจากการตั้งค่า"><i class="fa-solid fa-eraser"></i> ล้างข้อมูล WIP ทั้งหมด</div></div>
                </details>
            </div>`);
    }

    // 4) links to books that don't exist
    if (m.missing.length) {
        parts.push(`
            <div class="lt_card">
                <div class="lt_card_title"><i class="fa-solid fa-link-slash"></i> ลิงก์ไปยังเล่มที่ไม่มีแล้ว (${m.missing.length})</div>
                <div class="lt_dim">เล่มเสริมถอดลิงก์จากตรงนี้ได้ ส่วนเล่มหลักของการ์ดหรือ Chat Lore ให้เปิดการ์ด/แชทนั้นแล้วเลือกเล่มใหม่</div>
                ${m.missing.map((x, i) => `<div class="lt_mini">${escapeHtml(x.where)} → <b>${escapeHtml(x.book)}</b>${x.fix ? ` <span class="lt_link lt_fixmissing" data-i="${i}">ถอดลิงก์</span>` : ''}</div>`).join('')}
            </div>`);
    }

    // 5) charLore entries for deleted characters (only trustworthy once the character list is loaded)
    if (m.staleCharLore.length && characterList().length) {
        parts.push(`
            <div class="lt_card">
                <div class="lt_card_title"><i class="fa-solid fa-user-slash"></i> ข้อมูลเล่มเสริมของการ์ดที่ลบไปแล้ว (${m.staleCharLore.length})</div>
                <div class="lt_dim">ตอนลบการ์ด SillyTavern ไม่ได้ลบรายการเล่มเสริมของการ์ดนั้นในการตั้งค่า ล้างได้โดยไม่กระทบตัว lorebook</div>
                ${m.staleCharLore.map(e => `<div class="lt_mini">${escapeHtml(e.name)} <span class="lt_dim">→ ${(e.extraBooks ?? []).map(escapeHtml).join(', ')}</span></div>`).join('')}
                <div class="lt_btns"><div class="menu_button" id="lt_clean_stale"><i class="fa-solid fa-eraser"></i> ล้าง</div></div>
            </div>`);
    }

    if (!parts.length) parts.push('<div class="lt_empty">ไม่มีลิงก์ค้าง 👍</div>');
    return parts.join('');
}

function wireTools(body) {
    const c = ctx();
    body.querySelector('#lt_wip_unglobal')?.addEventListener('click', () => {
        const names = [...body.querySelectorAll('.lt_wipg:checked')].map(i => i.value);
        if (!names.length) return;
        removeFromGlobal(names);
        toast.ok(`ถอด ${names.length} เล่มออกจาก Global แล้ว`);
        refresh();
    });
    body.querySelector('#lt_wip_bind')?.addEventListener('click', async () => {
        const pick = body.querySelector('input[name="lt_wipchat"]:checked')?.value;
        if (!pick) return;
        c.chatMetadata.world_info = pick;
        await c.saveMetadata();
        toast.ok(`ผูก "${pick}" เป็น Chat Lore ของแชทนี้แล้ว`);
        refresh();
    });
    body.querySelector('#lt_wip_forget')?.addEventListener('click', () => {
        if (!confirm('ลบข้อมูลการผูกแชทของ WorldInfoPlus ทั้งหมด?\nตัว lorebook ไม่ถูกลบ แต่รายการว่าแชทไหนเคยผูกเล่มไหนจะหายไป')) return;
        const wip = wipSettings();
        if (wip) { wip.chatLorebooks = {}; delete wip.injectedGlobal; }
        c.saveSettingsDebounced();
        refresh();
    });
    body.querySelectorAll('.lt_fixmissing').forEach(el => el.addEventListener('click', () => {
        const x = ui.model.missing[Number(el.dataset.i)];
        const entry = world_info?.charLore?.find(e => e.name === x?.fix?.stem);
        if (!entry) return;
        entry.extraBooks = (entry.extraBooks ?? []).filter(b => b !== x.book);
        if (!entry.extraBooks.length) world_info.charLore.splice(world_info.charLore.indexOf(entry), 1);
        c.saveSettingsDebounced();
        refresh();
    }));
    body.querySelector('#lt_clean_stale')?.addEventListener('click', () => {
        const stale = new Set(ui.model.staleCharLore);
        world_info.charLore = (world_info.charLore ?? []).filter(e => !stale.has(e));
        c.saveSettingsDebounced();
        toast.ok(`ล้างแล้ว ${stale.size} รายการ`);
        refresh();
    });
}

/** Deselect books in the Global World Info selector (goes through SillyTavern's own change handler). */
function removeFromGlobal(names) {
    const drop = new Set(names);
    const $sel = $('#world_info');
    const vals = ($sel.val() || []).filter(v => !drop.has(world_names[Number(v)]));
    $sel.val(vals).trigger('change');
}

// ---------------------------------------------------------------- entry points

function injectButton() {
    if (document.getElementById('lt_open_btn')) return;
    const anchor = document.getElementById('world_import_button');
    if (!anchor) return;
    const btn = document.createElement('div');
    btn.id = 'lt_open_btn';
    btn.className = 'menu_button fa-solid fa-broom';
    btn.title = 'จัดระเบียบ lorebook (Lore Tidy)';
    btn.addEventListener('click', openModal);
    anchor.before(btn);
}

function renderSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('lt_settings')) return;
    host.insertAdjacentHTML('beforeend', `
    <div id="lt_settings" class="lt_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Lore Tidy</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="menu_button menu_button_icon" id="lt_settings_open"><i class="fa-solid fa-broom"></i> เปิด Lore Tidy</div>
                <small class="lt_note">เปิดจากปุ่มไม้กวาดในแผง World Info หรือพิมพ์ <code>/loretidy</code> ก็ได้</small>
            </div>
        </div>
    </div>`);
    document.getElementById('lt_settings_open').addEventListener('click', openModal);
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'loretidy',
        callback: () => { openModal(); return ''; },
        helpString: 'เปิด Lore Tidy — ดูว่า lorebook แต่ละเล่มถูกใช้ที่ไหน และลบเล่มที่ไม่มีใครใช้',
    }));
}

function init() {
    ctx().extensionSettings[MODULE] ??= {};
    injectButton();
    renderSettings();
    registerCommand();
    const { eventSource, event_types: E } = ctx();
    // Chats or characters changed: the next open rescans chat lore.
    for (const ev of [E.CHAT_CHANGED, E.CHAT_DELETED, E.CHARACTER_DELETED, E.CHARACTER_EDITED, E.CHARACTER_RENAMED].filter(Boolean)) {
        eventSource.on(ev, () => { scanDirty = true; });
    }
    for (const ev of [E.CHARACTER_PAGE_LOADED, E.APP_READY].filter(Boolean)) {
        eventSource.on(ev, () => { if (chatScan.state === 'nochars' && document.getElementById('lt_modal')) startScan(); });
    }
    for (const ev of [E.WORLDINFO_SETTINGS_UPDATED, E.CHAT_CHANGED, E.WORLDINFO_UPDATED].filter(Boolean)) {
        eventSource.on(ev, () => { if (!ui.busy) refresh(); });
    }
    console.log(LOG, 'loaded');
}

globalThis.LoreTidy = { open: openModal, buildModel, scanChats, makeZip, get chatScan() { return chatScan; } };

if (typeof jQuery === 'function') jQuery(init); else init();
