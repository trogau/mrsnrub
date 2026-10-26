/* cdn-explorer.js — CDN Explorer page logic.
   Vanilla JS, classic script, fetch-based (local dev server). All dynamic
   text is escaped through esc(); tooltips use data-tip (CSS only). */
(function () {
'use strict';

const $ = (s) => document.querySelector(s);

function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
}

async function api(path, opts) {
    const r = await fetch('/api' + path, opts);
    if (!r.ok) {
        let msg = r.status + ' ' + r.statusText;
        try { msg = (await r.json()).error || msg; } catch (e) { /* not json */ }
        throw new Error(msg);
    }
    return r.json();
}

function fmtBytes(n) {
    if (n === null || n === undefined) return '–';
    const u = ['B', 'K', 'M', 'G'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
}

function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
        return;
    }
    fallbackCopy(t);
}
function fallbackCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
}

function postJSON(path, body) {
    return api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

const STATUSES = ['unknown', 'identified', 'decoded', 'skipped', 'error'];
const KINDS = ['magic', 'format', 'decode', 'reference', 'decision'];
const TIERS = ['25', '50', '100', 'iphone', 'ipad', 'ipad3', 'retina',
    'wav', 'mp3', 'caf'];

const S = {
    tab: 'files',
    filters: { source: '', status: '', format: '', tier: '', q: '', sidecar: 0 },
    page: 1,
    perPage: 200,
    total: 0,
    formats: [],
    sources: [],
    detail: null,          // last /api/files/{id} payload
    sel: null,             // {kind:'file', id} | {kind:'entry', id, fileId}
    hexOffset: 0,
    pollTimer: null,
    busy: 0
};

/* ---------------------------------------------------------------- stats bar */

function renderStatsBar(st) {
    const s = $('#statsbar');
    if (!st) { s.textContent = '…'; return; }
    const f = st.files, src = st.sources;
    const b = (k, cls) => (f.by_status[k] ? ` <b class="${cls || ''}">${f.by_status[k]}</b> ${k}` : '');
    s.innerHTML =
        `<b>${f.total.toLocaleString()}</b> files` +
        b('identified', 's-identified') + b('decoded', 's-decoded') +
        b('error', 's-error') +
        ` · <b>${f.sidecars}</b> sidecars` +
        ` · scans <b>${src.done}/${src.total}</b>` +
        (st.active_jobs ? ` · <b>${st.active_jobs}</b> job(s) running` : '');
}

async function pollMeta() {
    let stats = null;
    try {
        const [st, src, fmt] = await Promise.all([
            api('/stats'), api('/sources'), api('/formats')
        ]);
        stats = st;
        S.sources = src;
        S.formats = fmt.formats;
        renderStatsBar(st);
        renderSourceFilter();
        const settled = st.active_jobs === 0 && src.every((x) => x.scan_state === 'done');
        if (settled) {
            stopPoll();
            if (S.tab === 'files') loadFiles();   // refresh after scans land
        }
    } catch (e) {
        $('#statsbar').textContent = 'server unreachable: ' + e.message;
    }
    return stats;
}

function startPoll() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(pollMeta, 2500);
}
function stopPoll() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

/* ------------------------------------------------------------------- files */

function renderSourceFilter() {
    const sel = $('#f-source');
    const cur = sel.value;
    sel.innerHTML = '<option value="">all sources</option>' +
        S.sources.map((s) => {
            const st = s.scan_state === 'done' ? '' : ` [${s.scan_state}]`;
            return `<option value="${s.id}">${esc(s.name)}${st}</option>`;
        }).join('');
    sel.value = cur;
    const fmtSel = $('#f-format');
    const curFmt = fmtSel.value;
    fmtSel.innerHTML = '<option value="">all</option>' +
        S.formats.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');
    fmtSel.value = curFmt;
}

function currentFilterParams(extra) {
    const p = new URLSearchParams();
    for (const k of ['source', 'status', 'format', 'tier', 'q']) {
        if (S.filters[k]) p.set(k, S.filters[k]);
    }
    if (S.filters.sidecar) p.set('sidecar', '1');
    if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
}

async function loadFiles() {
    try {
        const d = await api('/files?' + currentFilterParams(
            { page: S.page, per_page: S.perPage }));
        S.total = d.total;
        renderFileTable(d.items);
    } catch (e) {
        $('#tablewrap').innerHTML =
            `<div class="placeholder">${esc(e.message)}</div>`;
    }
}

function statusBadge(st) {
    return `<span class="badge b-${esc(st)}">${esc(st)}</span>`;
}

function renderFileTable(items) {
    const wrap = $('#tablewrap');
    if (!items.length) {
        wrap.innerHTML = '<div class="placeholder">No files match.</div>';
    } else {
        wrap.innerHTML =
            '<table class="ftable"><thead><tr>' +
            '<th>file</th><th>size</th><th>format</th><th>status</th>' +
            '</tr></thead><tbody>' +
            items.map((f) => {
                const dir = f.cdn_path.includes('/')
                    ? f.cdn_path.slice(0, f.cdn_path.lastIndexOf('/') + 1) : '';
                const name = f.cdn_path.slice(dir.length);
                const nm = [f.tier && 't:' + f.tier, f.lang && f.lang,
                    f.season && f.season, f.revision && 'r' + f.revision]
                    .filter(Boolean).join(' ');
                const side = f.is_sidecar
                    ? ' <span class="badge b-sidecar" data-tip="sidecar of its .zip">⏱</span>'
                    : '';
                const sel = S.sel && S.sel.kind === 'file' && S.sel.id === f.id
                    ? ' sel' : '';
                return `<tr class="frow${sel}" data-id="${f.id}">` +
                    `<td class="name">${esc(dir)}<b>${esc(name)}</b>${side}` +
                    (nm ? `<div class="dim">${esc(nm)}</div>` : '') + `</td>` +
                    `<td class="num">${fmtBytes(f.size)}</td>` +
                    `<td class="dim">${esc(f.format || '')}</td>` +
                    `<td>${statusBadge(f.status)}</td></tr>`;
            }).join('') +
            '</tbody></table>';
    }
    const pages = Math.max(1, Math.ceil(S.total / S.perPage));
    $('#pg-info').textContent =
        `page ${S.page}/${pages} · ${S.total.toLocaleString()} files`;
    $('#pg-prev').disabled = S.page <= 1;
    $('#pg-next').disabled = S.page >= pages;
}

/* ----------------------------------------------------------------- mystery */

async function loadMystery() {
    const el = $('#pane-mystery');
    try {
        const d = await api('/mystery');
        if (!d.groups.length) {
            el.innerHTML = '<div class="placeholder">Nothing unknown left —' +
                ' everything is triaged. Nice.</div>';
            return;
        }
        el.innerHTML =
            `<div class="muted" style="padding:4px 12px 8px">Unknown files` +
            ` grouped by name pattern — pick a group, then a target.</div>` +
            d.groups.map((g) =>
                `<div class="mgroup"><h4>${esc(g.name)}</h4>` +
                `<span class="mcount">${g.count} file(s) · ${fmtBytes(g.bytes)}` +
                (g.tiers.length ? ` · tiers ${g.tiers.map(esc).join('/')}` : '') +
                (g.langs.length ? ` · langs ${g.langs.map(esc).join('/')}` : '') +
                ` · ${g.sources.map(esc).join(', ')}</span>` +
                `<div class="msamples">` +
                g.samples.map((s) =>
                    `<a data-path="${esc(s)}">${esc(s)}</a>`).join('') +
                `</div></div>`).join('');
    } catch (e) {
        el.innerHTML = `<div class="placeholder">${esc(e.message)}</div>`;
    }
}

/* ------------------------------------------------------------------- detail */

async function selectFile(id) {
    try {
        S.detail = await api('/files/' + id);
        S.sel = { kind: 'file', id };
        S.hexOffset = 0;
        renderDetail();
        renderFileTableMark();
    } catch (e) {
        $('#right').innerHTML = `<div class="placeholder">${esc(e.message)}</div>`;
    }
}

function renderFileTableMark() {
    document.querySelectorAll('#tablewrap .frow').forEach((tr) => {
        tr.classList.toggle('sel',
            S.sel && S.sel.kind === 'file' && +tr.dataset.id === S.sel.id);
    });
}

function statusOptions(cur) {
    return STATUSES.map((s) =>
        `<option value="${s}"${s === cur ? ' selected' : ''}>${s}</option>`
    ).join('');
}
function formatOptions(cur) {
    return '<option value="">(none)</option>' +
        S.formats.map((f) =>
            `<option value="${esc(f.name)}"${f.name === cur ? ' selected' : ''}>` +
            `${esc(f.name)}</option>`).join('');
}

function renderDetail() {
    const d = S.detail, f = d.file;
    const right = $('#right');
    const naming = [
        ['family', f.family], ['tier', f.tier], ['lang', f.lang],
        ['season', f.season], ['revision', f.revision && 'r' + f.revision],
        ['sig', f.sig]
    ].filter(([, v]) => v).map(([k, v]) =>
        `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
    const gens = d.generations.length
        ? `<div class="card"><h3>Generations — “${esc(f.base_name)}”` +
          ` (${d.generations.length})</h3><table class="gens">` +
          d.generations.map((g) =>
              `<tr data-id="${g.id}" class="${g.id === f.id ? 'here' : ''}">` +
              `<td>${esc(g.cdn_path)}</td><td>${esc(g.source_name)}</td>` +
              `<td>${fmtBytes(g.size)}</td>` +
              `<td>${g.revision ? 'r' + esc(g.revision) : ''}` +
              (g.sig ? ' ' + esc(g.sig) : '') + `</td>` +
              `<td>${statusBadge(g.status)}</td></tr>`).join('') +
          '</table></div>'
        : '';
    right.innerHTML =
        `<div class="card">
            <div class="path">${esc(f.cdn_path)}</div>
            <div class="chips">source <b>${esc(d.source ? d.source.name : '?')}</b>` +
            ` · <b>${fmtBytes(f.size)}</b>` +
            (f.is_sidecar
                ? ` · ⏱ sidecar${f.sidecar_of
                    ? ` of <a href="#" id="sidecar-link" data-id="${f.sidecar_of}">parent zip</a>`
                    : ''}`
                : '') +
            `</div>
            ${naming ? `<table class="naming">${naming}</table>` : ''}
            <div class="editrow">
                <label>status</label><select id="ed-status">${statusOptions(f.status)}</select>
                <label>format</label><select id="ed-format">${formatOptions(f.format)}</select>
                <button id="ed-save">save</button>
            </div>
            <textarea class="notes" id="ed-notes" data-tip="free notes about this file — persisted to the DB">${esc(f.notes || '')}</textarea>
            <div class="sha">sha256
                <code id="sha-val">${esc(f.sha256 || '—')}</code>
                ${f.sha256 ? '' : '<button id="sha-go" data-tip="queue a background hash of the extracted member">compute</button>'}
            </div>
            <div class="actions">
                <button id="btn-open" data-tip="extract to local cache and list the zip contents">${d.entries.length ? 'Reopen zip' : 'Open zip'}</button>
                <button id="btn-spec" data-tip="show the --dlc JSON spec for tools/extract_assets.py (copies nothing, runs nothing)">--dlc pipeline spec</button>
                <a href="assets-explorer.html" data-tip="the Asset Explorer (APK-extracted + previously decoded DLC)">Asset Explorer ↗</a>
                <button id="btn-rescan" data-tip="re-list this whole bundle (resets its rows)">Rescan bundle</button>
            </div>
        </div>
        ${gens}
        <div class="card"><h3>Virtual file system</h3>
            <div class="tree" id="tree"></div>
        </div>
        <div id="entry-panel"></div>
        <div class="card"><h3>Findings — file</h3>
            <div id="file-findings"></div>
            ${findingForm('file', f.id)}
        </div>`;
    renderTree();
    renderFindings($('#file-findings'), 'file', f.id);
    wireDetail();
}

function parentOf(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
}
function leafOf(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
}

function renderTree() {
    const el = $('#tree');
    const entries = S.detail ? S.detail.entries : [];
    if (!entries.length) {
        el.innerHTML = '<div class="muted">not opened yet — press' +
            ' <b>Open zip</b> (extracts the member to the local cache).</div>';
        return;
    }
    // every listed entry is already in the detail payload, so the whole
    // virtual tree renders at once (opens append rows, re-render follows)
    el.innerHTML = `<div>${treeLevel('', entries)}</div>`;
}

function treeLevel(prefix, entries) {
    const kids = entries
        .filter((e) => parentOf(e.entry_path) === prefix)
        .map((e) => {
            const childList = entries.filter(
                (c) => parentOf(c.entry_path) === e.entry_path);
            const hasKids = childList.length > 0;
            const sel = S.sel && S.sel.kind === 'entry' && S.sel.id === e.id
                ? ' sel' : '';
            const magic = e.magic
                ? `<span class="tmagic" data-tip="first 16 bytes">${esc(e.magic.split(' ').slice(0, 4).join(' '))}…</span>`
                : '';
            return `<div class="trow${sel}" data-eid="${e.id}" data-path="${esc(e.entry_path)}">` +
                `<span class="tw">${hasKids ? '▸' : '·'}</span>` +
                `<span class="tname">${esc(leafOf(e.entry_path))}</span>` +
                `${e.format ? `<span class="badge b-${e.format === 'unknown' ? 'unknown' : 'zip'}">${esc(e.format)}</span>` : ''}` +
                magic +
                `<span class="tsize">${fmtBytes(e.size)}</span></div>` +
                (hasKids
                    ? `<div style="padding-left:16px">${treeLevel(e.entry_path, entries)}</div>`
                    : '');
        }).join('');
    return kids;
}

/* ------------------------------------------------------------------ entry */

function selectEntry(id, entryObj) {
    S.sel = { kind: 'entry', id, fileId: entryObj.parent_id, entry: entryObj };
    S.hexOffset = 0;
    const ep = $('#entry-panel');
    const e = entryObj;
    const isZip = e.format === 'zip';
    ep.innerHTML =
        `<div class="card"><h3>Entry</h3>
            <div class="path">${esc(e.entry_path)}</div>
            <div class="chips"><b>${fmtBytes(e.size)}</b> · ${esc(e.method || '?')}` +
            (e.crc32 ? ` · crc ${('00000000' + (e.crc32 >>> 0).toString(16)).slice(-8)}` : '') +
            (e.magic ? ` · magic <b style="font-family:monospace">${esc(e.magic)}</b>` : '') +
            `</div>
            <div class="epanes">
                <div>
                    <h3 style="margin-top:2px">Preview</h3>
                    <div class="preview" id="epreview"><span class="noper">loading…</span></div>
                </div>
                <div>
                    <h3 style="margin-top:2px">Hex</h3>
                    <div class="hexbar">
                        <button id="hx-prev">← 256</button>
                        <button id="hx-next">+256 →</button>
                        <span>offset</span><input id="hx-off" value="0">
                        <button id="hx-go">go</button>
                    </div>
                    <pre class="hex" id="hexpre">…</pre>
                </div>
            </div>
            <div class="editrow">
                <label>status</label><select id="ee-status">${statusOptions(e.status)}</select>
                <label>format</label><select id="ee-format">${formatOptions(e.format)}</select>
                <button id="ee-save">save</button>
                ${isZip ? `<button id="ee-open" data-tip="this entry is itself a zip — list its members">open nested zip</button>` : ''}
            </div>
        </div>
        <div class="card"><h3>Findings — entry</h3>
            <div id="entry-findings"></div>
            ${findingForm('entry', e.id)}
        </div>`;
    renderHex();
    loadPreview();
    renderFindings($('#entry-findings'), 'entry', e.id);
    wireEntry();
    renderTree();
    renderFileTableMark();
}

async function loadPreview() {
    const el = $('#epreview');
    if (!el) return;
    el.innerHTML = '<span class="noper">loading…</span>';
    try {
        const r = await fetch(`/api/entries/${S.sel.id}/preview`);
        if (!r.ok) {
            let msg = 'no preview';
            try { msg = (await r.json()).error || msg; } catch (e) { /* ok */ }
            el.innerHTML = `<span class="noper">${esc(msg)} — use the hex view</span>`;
            return;
        }
        const ct = r.headers.get('Content-Type') || '';
        if (ct.startsWith('image/')) {
            const url = URL.createObjectURL(await r.blob());
            el.innerHTML = `<img src="${url}" alt="preview">`;
        } else {
            el.innerHTML = `<pre>${esc(await r.text())}</pre>`;
        }
    } catch (e) {
        el.innerHTML = `<span class="noper">${esc(e.message)}</span>`;
    }
}

async function renderHex() {
    const el = $('#hexpre');
    if (!el) return;
    el.textContent = '…';
    try {
        const d = await api(`/entries/${S.sel.id}/hex?offset=${S.hexOffset}&length=256`);
        el.innerHTML = d.rows.map((r) =>
            `<span class="hoff">${('00000000' + (S.hexOffset + r[0]).toString(16).slice(-8))}</span>  ` +
            `<span class="hhex">${esc(r[1])}</span>  <span class="hasc">${esc(r[2])}</span>`
        ).join('\n') || '<span class="hoff">(empty)</span>';
        const off = $('#hx-off');
        if (off && document.activeElement !== off) off.value = String(S.hexOffset);
    } catch (e) {
        el.textContent = e.message;
    }
}

function findingForm(target, id) {
    return `<div class="fadd">
        <div class="frow1">
            <select id="ff-kind-${target}-${id}">
                ${KINDS.map((k) => `<option>${k}</option>`).join('')}
            </select>
            <input type="text" id="ff-sum-${target}-${id}" placeholder="one-line summary (required)">
        </div>
        <textarea id="ff-body-${target}-${id}" placeholder="body: byte offsets, evidence, what's still unknown (markdown-ish)"></textarea>
        <div><button id="ff-add-${target}-${id}">add finding</button></div>
    </div>`;
}

async function renderFindings(el, target, id) {
    if (!el) return;
    try {
        const d = await api(`/findings?target=${target}&target_id=${id}`);
        el.innerHTML = d.findings.map((f) =>
            `<div class="finding">
                <button class="del" data-fid="${f.id}" data-tip="delete this finding">✕</button>
                <span class="kind k-${esc(f.kind)}">${esc(f.kind)}</span>
                <b>${esc(f.summary)}</b>
                <span class="when">${esc((f.created_at || '').replace('T', ' ').slice(0, 19))}</span>
                ${f.body ? `<pre class="fbody">${esc(f.body)}</pre>` : ''}
            </div>`).join('') || '<div class="muted">no findings yet</div>';
        el.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
            try {
                await api('/findings/' + b.dataset.fid, { method: 'DELETE' });
                renderFindings(el, target, id);
            } catch (e) { alert(e.message); }
        }));
    } catch (e) {
        el.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
}

/* ------------------------------------------------------------------ wiring */

function wireDetail() {
    const f = S.detail.file;
    $('#ed-save').addEventListener('click', async () => {
        try {
            await postJSON('/files/' + f.id, {
                status: $('#ed-status').value,
                format: $('#ed-format').value || null,
                notes: $('#ed-notes').value
            });
            selectFile(f.id);
        } catch (e) { alert(e.message); }
    });
    const openBtn = $('#btn-open');
    if (openBtn) openBtn.addEventListener('click', async () => {
        openBtn.disabled = true;
        try {
            const d = await api(`/files/${f.id}/open`);
            alert(`listed ${d.opened} entries`);
            selectFile(f.id);
        } catch (e) { alert(e.message); }
        openBtn.disabled = false;
    });
    const specBtn = $('#btn-spec');
    if (specBtn) specBtn.addEventListener('click', async () => {
        try {
            const d = await api(`/pipeline-spec?file_id=${f.id}`);
            $('#specpre').textContent = d.json;
            $('#specdlg').showModal();
        } catch (e) { alert(e.message); }
    });
    const shaBtn = $('#sha-go');
    if (shaBtn) shaBtn.addEventListener('click', () => {
        shaBtn.disabled = true;
        (async () => {
            try {
                await api(`/files/${f.id}/sha256`);
                let waited = 0;
                while (waited < 120) {
                    await new Promise((r) => setTimeout(r, 1500));
                    waited += 1500;
                    const d = await api('/files/' + f.id);
                    if (d.file.sha256) {
                        $('#sha-val').textContent = d.file.sha256;
                        return;
                    }
                }
                $('#sha-val').textContent = 'still computing…';
            } catch (e) { alert(e.message); }
            shaBtn.disabled = false;
        })();
    });
    const rescan = $('#btn-rescan');
    if (rescan) rescan.addEventListener('click', async () => {
        if (!confirm(`Re-list bundle “${(S.detail.source && S.detail.source.name) || ''}”? This resets its indexed rows.`)) return;
        try {
            await postJSON(`/sources/${S.detail.source.id}/scan`, {});
            startPoll();
            alert('rescan queued');
        } catch (e) { alert(e.message); }
    });
    const sideLink = $('#sidecar-link');
    if (sideLink) sideLink.addEventListener('click', (ev) => {
        ev.preventDefault();
        selectFile(+sideLink.dataset.id);
    });
    // generations jump
    document.querySelectorAll('#right .gens tr').forEach((tr) =>
        tr.addEventListener('click', () => selectFile(+tr.dataset.id)));
    // tree
    // tree: clicking an unopened zip lists its members, clicking anything
    // else selects it (already-listed zips are just selected)
    $('#tree').addEventListener('click', (ev) => {
        const row = ev.target.closest('.trow');
        if (!row) return;
        const e = S.detail.entries.find((x) => x.id === +row.dataset.eid);
        if (!e) return;
        const listed = S.detail.entries.some(
            (c) => parentOf(c.entry_path) === e.entry_path);
        if (e.format === 'zip' && !listed) {
            (async () => {
                try {
                    const d = await api(`/entries/${e.id}/open`);
                    selectFile(f.id);
                } catch (err) { alert(err.message); }
            })();
            return;
        }
        selectEntry(e.id, e);
    });
    // findings add + delete (file level)
    wireFindingForm('file', f.id, () => renderFindings($('#file-findings'), 'file', f.id));
}

function wireEntry() {
    const e = S.sel.entry;
    $('#ee-save').addEventListener('click', async () => {
        try {
            await postJSON('/entries/' + e.id, {
                status: $('#ee-status').value,
                format: $('#ee-format').value || null
            });
            // refresh from parent file detail
            selectFile(e.parent_id);
            const fresh = S.detail.entries.find((x) => x.id === e.id);
            if (fresh) selectEntry(e.id, fresh);
        } catch (err) { alert(err.message); }
    });
    const openBtn = $('#ee-open');
    if (openBtn) openBtn.addEventListener('click', async () => {
        openBtn.disabled = true;
        try {
            await api(`/entries/${e.id}/open`);
            selectFile(e.parent_id);
            const fresh = S.detail.entries.find((x) => x.id === e.id);
            if (fresh) selectEntry(e.id, fresh);
        } catch (err) { alert(err.message); }
        openBtn.disabled = false;
    });
    const step = (delta) => {
        S.hexOffset = Math.max(0, S.hexOffset + delta);
        renderHex();
    };
    $('#hx-prev').addEventListener('click', () => step(-256));
    $('#hx-next').addEventListener('click', () => step(256));
    $('#hx-go').addEventListener('click', () => {
        const v = parseInt($('#hx-off').value, 10);
        if (!isNaN(v) && v >= 0) { S.hexOffset = v; renderHex(); }
    });
    wireFindingForm('entry', e.id, () => renderFindings($('#entry-findings'), 'entry', e.id));
}

function wireFindingForm(target, id, refresh) {
    const add = $(`#ff-add-${target}-${id}`);
    add.addEventListener('click', async () => {
        const summary = $(`#ff-sum-${target}-${id}`).value.trim();
        if (!summary) { alert('summary is required'); return; }
        try {
            await postJSON('/findings', {
                target, target_id: id,
                kind: $(`#ff-kind-${target}-${id}`).value,
                summary,
                body: $(`#ff-body-${target}-${id}`).value.trim() || null
            });
            $(`#ff-sum-${target}-${id}`).value = '';
            $(`#ff-body-${target}-${id}`).value = '';
            refresh();
        } catch (e) { alert(e.message); }
    });
}

/* ------------------------------------------------------------------ init */

function wireGlobal() {
    const applyFilters = () => {
        S.filters.source = $('#f-source').value;
        S.filters.status = $('#f-status').value;
        S.filters.format = $('#f-format').value;
        S.filters.tier = $('#f-tier').value;
        S.filters.sidecar = $('#f-sidecar').checked ? 1 : 0;
        S.page = 1;
        if (S.tab === 'files') loadFiles();
    };
    for (const id of ['f-source', 'f-status', 'f-format', 'f-tier']) {
        $('#' + id).addEventListener('change', applyFilters);
    }
    $('#f-sidecar').addEventListener('change', applyFilters);

    let t;
    $('#search').addEventListener('input', (ev) => {
        clearTimeout(t);
        t = setTimeout(() => {
            S.filters.q = ev.target.value.trim();
            S.page = 1;
            if (S.tab === 'files') loadFiles();
        }, 300);
    });

    $('#pg-prev').addEventListener('click', () => { S.page--; loadFiles(); });
    $('#pg-next').addEventListener('click', () => { S.page++; loadFiles(); });

    $('#tab-files').addEventListener('click', () => setTab('files'));
    $('#tab-mystery').addEventListener('click', () => setTab('mystery'));

    // delegated: file rows + mystery samples + spec copy
    $('#tablewrap').addEventListener('click', (ev) => {
        const row = ev.target.closest('.frow');
        if (row) selectFile(+row.dataset.id);
    });
    $('#pane-mystery').addEventListener('click', (ev) => {
        const a = ev.target.closest('a[data-path]');
        if (!a) return;
        ev.preventDefault();
        setTab('files');
        S.filters.q = a.dataset.path;
        $('#search').value = S.filters.q;
        S.page = 1;
        loadFiles();
    });
    $('#spec-copy').addEventListener('click', () =>
        copyText($('#specpre').textContent));

    $('#f-tier').innerHTML = '<option value="">all</option>' +
        TIERS.map((t) => `<option>${t}</option>`).join('');
}

function setTab(tab) {
    S.tab = tab;
    $('#tab-files').classList.toggle('on', tab === 'files');
    $('#tab-mystery').classList.toggle('on', tab === 'mystery');
    $('#pane-files').hidden = tab !== 'files';
    $('#pane-mystery').hidden = tab !== 'mystery';
    if (tab === 'mystery') loadMystery();
}

async function init() {
    wireGlobal();
    await pollMeta();
    startPoll();
    loadFiles();
}

init();
})();
