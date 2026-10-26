/* progress.js — Progress dashboard page logic (2026-10-18).
   Renders the latest snapshot served by api/progress.php: meters with
   bars / deltas / sparkline trends, the per-bundle coverage grid, and the
   session journal. The task & decision board moved to its own page
   (tasks/index.html + tasks/js/tasks.js) on 2026-10-25; it shares this
   page's API.
   Needs the PHP server (fetch); unlike the other explorers this page
   does not work from file://. */
(function () {
'use strict';

var API = 'api/progress.php';
var SECTIONS = [
    ['cdn', 'CDN funnel'],
    ['formats', 'Format RE'],
    ['native', 'Native (.so) RE'],
    ['serverapi', 'Server API'],
    ['assets', 'Asset pipeline'],
    ['map', 'Map & city']
];

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}
function $(id) { return document.getElementById(id); }

function post(body) {
    return fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
}

function fmt(n) { return n == null ? '' : Number(n).toLocaleString('en-US'); }

function pctOf(m) {
    return (m.den && m.den > 0) ? (100 * m.num / m.den) : null;
}

/* ---- meters -------------------------------------------------------------- */

function meterRow(m, key, prevNum, hist) {
    var row = document.createElement('div');
    row.className = 'metric';
    var pct = pctOf(m);
    if (pct !== null) {
        if (pct >= 99.5) { row.classList.add('full'); }
        else if (pct === 0) { row.classList.add('zero'); }
    }
    var detail = '';
    try { detail = m.detail ? JSON.parse(m.detail) : ''; } catch (e) { detail = m.detail; }
    var tip = m.label + ' — ' + fmt(m.num) + (m.den ? ' / ' + fmt(m.den) : '');
    if (pct !== null) { tip += ' (' + pct.toFixed(1) + '%)'; }
    if (detail) { tip += ' · ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)); }
    row.setAttribute('data-tip', tip);

    var label = document.createElement('span');
    label.className = 'm-label';
    label.textContent = m.label;
    var nums = document.createElement('span');
    nums.className = 'm-nums';
    nums.innerHTML = '<span class="m-num">' + fmt(m.num) + '</span>' +
        (m.den ? ' <span class="m-den">/ ' + fmt(m.den) +
            ' <span class="m-den">' + pct.toFixed(1) + '%</span></span>' : '') +
        (m.unit ? ' <span class="m-den">' + esc(m.unit) + '</span>' : '');
    var pk = m.section + '|' + m.key;
    if (prevNum != null) {
        var d = m.num - prevNum;
        var sp = document.createElement('span');
        sp.className = 'm-delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
        sp.textContent = d > 0 ? '▲+' + fmt(d) : d < 0 ? '▼' + fmt(d) : '·';
        nums.appendChild(sp);
    }
    row.appendChild(label);
    row.appendChild(nums);
    if (pct !== null) {
        var bar = document.createElement('div');
        bar.className = 'm-bar';
        var fill = document.createElement('i');
        fill.style.width = Math.max(0.5, Math.min(100, pct)) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
    }
    var pts = (hist || []).filter(function (p) { return p.num != null; });
    if (pts.length >= 2) {
        var cv = document.createElement('canvas');
        cv.className = 'm-spark';
        cv.width = 90; cv.height = 16;
        cv.style.marginLeft = '6px';
        row.appendChild(cv);
        drawSpark(cv, pts);
    }
    return row;
}

function drawSpark(cv, pts) {
    var ctx = cv.getContext('2d');
    var w = cv.width, h = cv.height;
    var vals = pts.map(function (p) { return p.den ? p.num / p.den : p.num; });
    var max = Math.max.apply(null, vals);
    var min = Math.min.apply(null, vals);
    if (max === min) { max = max + 1; min = min - 1; }
    ctx.strokeStyle = '#f4d03f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    vals.forEach(function (v, i) {
        var x = pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * (w - 2) + 1;
        var y = h - 1 - ((v - min) / (max - min)) * (h - 2);
        if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
}

function renderMeters(data) {
    var host = $('meters');
    host.innerHTML = '';
    SECTIONS.forEach(function (pair) {
        var id = pair[0];
        var rows = (data.sections || {})[id];
        if (!rows || !rows.length) { return; }
        var card = document.createElement('div');
        card.className = 'card';
        card.style.marginBottom = '0';
        var h = document.createElement('h2');
        h.textContent = pair[1];
        if (id === 'map') {
            // Byte Map: where the city save's .pb bytes went, by RE status
            var a = document.createElement('a');
            a.className = 'sec-link';
            a.href = 'pb-layout.html';
            a.textContent = 'byte map \u2192';
            a.setAttribute('data-tip',
                'Byte Map: byte allocation of the decoded city save ' +
                '(Data.LandMessage .pb), coloured by RE status. ' +
                'Regenerate: python3 tools/gen_pb_layout.py');
            h.appendChild(a);
        }
        card.appendChild(h);
        rows.forEach(function (m) {
            card.appendChild(meterRow(m, id + '|' + m.key,
                (data.prev || {})[id + '|' + m.key],
                (data.history || {})[id + '|' + m.key]));
        });
        host.appendChild(card);
    });
}

/* ---- coverage grid --------------------------------------------------------- */

function renderCoverage(data) {
    var cov = data.coverage || [];
    var groups = {};
    var order = [];
    cov.forEach(function (c) {
        var g = c.season || '(other)';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(c);
    });
    order.sort().reverse();
    var host = $('coverage');
    host.innerHTML = '';
    order.forEach(function (g) {
        var items = groups[g].sort(function (a, b) {
            return a.bundle < b.bundle ? -1 : 1;
        });
        var box = document.createElement('div');
        box.className = 'covgroup';
        var covered = items.filter(function (c) { return c.packs > 0; }).length;
        var indexed = items.filter(function (c) { return c.indexed; }).length;
        var unpacked = items.filter(function (c) { return c.unpacked; }).length;
        var dl = items.filter(function (c) { return c.downloaded; }).length;
        var h = document.createElement('h3');
        h.textContent = g + ' — ' + dl + ' downloaded · ' + indexed +
            ' indexed · ' + unpacked + ' unpacked · ' + covered + ' decoded';
        box.appendChild(h);
        var chips = document.createElement('div');
        chips.className = 'chips';
        items.forEach(function (c) {
            var chip = document.createElement('span');
            var st = c.packs > 0 ? 'st-cover'
                : c.indexed ? 'st-index'
                : c.unpacked ? 'st-unpack'
                : c.downloaded ? 'st-down' : '';
            chip.className = 'chip ' + st;
            chip.setAttribute('data-tip', c.bundle + ' — ' +
                (c.packs ? c.packs + ' pack files decoded'
                    : c.indexed ? 'indexed in CDN Explorer'
                    : c.unpacked ? 'unpacked to disk'
                    : c.downloaded ? 'downloaded, untouched' : 'not downloaded'));
            chips.appendChild(chip);
        });
        box.appendChild(chips);
        host.appendChild(box);
    });
    $('covstats').textContent = cov.length + ' bundles';
    $('covlegend').innerHTML = [
        ['st-cover', 'contributing decoded packs'],
        ['st-index', 'indexed in Explorer'],
        ['st-unpack', 'unpacked'],
        ['st-down', 'downloaded, untouched'],
        ['', 'not downloaded']
    ].map(function (p) {
        return '<span><i class="sw ' + p[0] + '"></i>' + p[1] + '</span>';
    }).join('');
}

/* ---- journal -------------------------------------------------------------------- */

function renderLog(data) {
    var ul = $('loglist');
    ul.innerHTML = '';
    (data.log || []).forEach(function (e) {
        var li = document.createElement('li');
        li.innerHTML = '<span class="l-ts">' + esc(e.ts) + ' UTC</span>' +
            esc(e.message);
        ul.appendChild(li);
    });
}

/* ---- boot --------------------------------------------------------------------------- */

function renderError(msg) {
    var el = $('error');
    el.classList.remove('hidden');
    el.textContent = msg;
}

function load() {
    return fetch(API, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.error) { renderError(data.error); return; }
            $('statsbar').textContent =
                'snapshot #' + data.snapshot.id + ' · ' + data.snapshot.taken_at +
                ' UTC' + (data.snapshot.note ? ' · ' + data.snapshot.note : '');
            renderMeters(data);
            renderCoverage(data);
            renderLog(data);
        })
        .catch(function (e) {
            renderError('Progress API unreachable (' + e + ') — this page needs ' +
                'the PHP server; open it via the http:// URL, not file://.');
        });
}

$('logform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var msg = $('logmsg').value.trim();
    if (!msg) { return; }
    post({ action: 'log', message: msg })
        .then(function () { $('logmsg').value = ''; load(); });
});

load();
})();
