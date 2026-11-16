// LearnLoop Activity Simulator — the page. No libraries: fetch, EventSource, hand-drawn SVG.
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const SVG = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => { const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const longTime = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ACTION_LABELS = { clear: 'Clear old log files', generate: 'Generate', upload: 'Upload', verify: 'Verify', publish: 'Publish the starting state', load: 'Load this scenario' };
const TARGET_LABELS = { cloudfront: 'Web access records', appLogs: 'Application records', state: "The app's starting state" };

const ui = { scenarios: [], selected: null, confirmations: {}, running: false, state: null };

// ------------------------------------------------------------------ helpers
async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}
/** The same canonical JSON as src/scenarios.js: keys sorted at every depth, no whitespace. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const grouped = (hex) => hex.match(/.{1,4}/g).join(' ');
const dryRun = () => $('#dry-run').checked;
const anchor = () => $('#anchor').value;

function showMoment(name) {
  for (const b of $$('.moments button')) b.setAttribute('aria-current', String(b.dataset.moment === name));
  for (const s of $$('.moment')) s.hidden = s.id !== `moment-${name}`;
}
function logLine(text, kind = '') {
  const line = el('div', { class: `line ${kind}`, text });
  $('#run-log').append(line);
  return line;
}

// ------------------------------------------------------------------ 1. scenario cards and the seal
// A combined scenario leads, full width, with the cases it prepares drawn inside it as
// numbered boxes (what changes, and for whom). One "Load this scenario" loads them all.
function caseBoxes(cases) {
  const grid = el('div', { class: 'case-grid' });
  cases.forEach((c, i) => grid.append(el('div', { class: 'case' },
    el('span', { class: 'case-num', text: String(i + 1) }),
    el('h4', { text: c.title }),
    el('p', { text: c.what_changes }),
    el('p', { class: 'case-who', text: c.who }))));
  return grid;
}

function renderCards() {
  const host = $('#cards');
  host.replaceChildren();
  const featured = ui.scenarios.filter((s) => s.cases?.length);
  const others = ui.scenarios.filter((s) => !s.cases?.length);
  const card = (s, isFeatured) => {
    const node = el('button', { type: 'button', class: isFeatured ? 'card featured' : 'card', role: 'radio', 'aria-checked': String(s.id === ui.selected) },
      ...(isFeatured ? [el('span', { class: 'case-count', text: `${s.cases.length} cases, loaded together with one button` })] : []),
      el('h3', { text: s.title }), el('p', { text: s.description }),
      ...(isFeatured ? [caseBoxes(s.cases)] : []));
    node.addEventListener('click', () => { ui.selected = s.id; renderCards(); updateFingerprint(); });
    return node;
  };
  // While a combined scenario exists it is the only one shown; the single-signal
  // scenarios stay available to the command line (npm run seed -- --scenario <id>).
  if (featured.length) for (const s of featured) host.append(card(s, true));
  else for (const s of others) host.append(card(s, false));
  const download = $('#business-review');
  if (download) {
    download.href = ui.selected ? `/api/scenarios/${encodeURIComponent(ui.selected)}/business-review` : '#';
    download.toggleAttribute('aria-disabled', !ui.selected);
  }
}
async function updateFingerprint() {
  const box = $('#fingerprint');
  if (!ui.selected || !anchor()) { box.textContent = '—'; return; }
  try {
    const { fingerprint } = await api(`/api/fingerprint?scenario=${encodeURIComponent(ui.selected)}&anchor=${anchor()}`);
    box.replaceChildren(el('span', { class: 'label', text: 'Fingerprint (SHA-256)' }), document.createTextNode(grouped(fingerprint)));
    const shown = JSON.parse(sessionStorage.getItem('shown') ?? '{}');
    shown[`${ui.selected}|${anchor()}`] = { fingerprint, at: new Date().toISOString() };
    sessionStorage.setItem('shown', JSON.stringify(shown));
  } catch (error) {
    box.textContent = error.message;
  }
}

// ------------------------------------------------------------------ the "currently loaded" strip
async function refreshLoaded({ readBack = false } = {}) {
  const strip = $('#loaded');
  try {
    const state = await api(`/api/state${readBack ? '?readBack=1' : ''}`);
    ui.state = state;
    strip.replaceChildren();
    const l = state.loaded;
    if (!l) {
      strip.append(document.createTextNode('Nothing has been loaded into AWS from this computer yet.'));
    } else {
      const title = ui.scenarios.find((s) => s.id === l.scenario)?.title ?? l.scenario;
      strip.append(
        document.createTextNode('Loaded now: '), el('strong', { text: title }),
        document.createTextNode(` · start date ${l.anchor} · loaded ${longTime(l.at)} by “${ACTION_LABELS[l.by] ?? l.by}” · `),
        document.createTextNode(l.published ? (l.published.skipped ? 'starting state already on LearnLoop main' : `starting state published ${longTime(l.published.at)} (${l.published.commit})`) : 'starting state not published yet'),
      );
    }
    if (state.buckets) {
      strip.append(el('div', { class: 'hint', text: `In AWS now: ${fmt(state.buckets.cloudfront.objects)} web access files (${state.buckets.cloudfront.firstDay ?? '—'} to ${state.buckets.cloudfront.lastDay ?? '—'}), ${fmt(state.buckets.appLogs.objects)} application record files, ${fmt(state.buckets.state.objects)} state documents.` }));
    } else if (state.bucketsError) {
      strip.append(el('div', { class: 'hint', text: `Could not read the buckets: ${state.bucketsError}` }));
    }
    const btn = el('button', { type: 'button', text: 'Read back from AWS' });
    btn.addEventListener('click', () => refreshLoaded({ readBack: true }));
    strip.append(btn);
  } catch (error) {
    strip.textContent = `Could not read the local state: ${error.message}`;
  }
}

// ------------------------------------------------------------------ actions
function confirmDialog(action) {
  return new Promise((resolve) => {
    const dialog = $('#confirm');
    $('#confirm-title').textContent = `${ACTION_LABELS[action]}?`;
    $('#confirm-text').textContent = ui.confirmations[action];
    $('#confirm-dry').hidden = !dryRun();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}

async function runAction(action) {
  if (ui.running) return;
  if (!ui.selected) { logLine('Choose a scenario first.', 'error'); return; }
  let token;
  if (ui.confirmations[action]) {
    if (!(await confirmDialog(action))) return;
    try {
      ({ token } = await api('/api/confirm', { method: 'POST', body: JSON.stringify({ action }) }));
    } catch (error) { logLine(error.message, 'error'); return; }
  }
  let started;
  try {
    started = await api(`/api/actions/${action}`, { method: 'POST', body: JSON.stringify({ scenario: ui.selected, anchor: anchor(), dryRun: dryRun(), token, pace: new URLSearchParams(location.search).get('pace') === 'fast' ? 'fast' : undefined }) });
  } catch (error) { logLine(error.message, 'error'); return; }
  setRunning(true);
  ui.runDry = started.dryRun;
  $('#run-log').replaceChildren();
  logLine(`${ACTION_LABELS[action]}${started.dryRun ? ' (rehearsal)' : ''}: started.`, 'note');
  follow(started.runId);
}

function setRunning(on) {
  ui.running = on;
  for (const b of [...$$('[data-action]'), $('#load'), $('#replay')]) b.disabled = on;
}

function follow(runId) {
  const source = new EventSource(`/api/runs/${runId}/events`);
  source.onmessage = (message) => handleEvent(JSON.parse(message.data), source);
  source.onerror = () => { source.close(); if (ui.running) { setRunning(false); refreshLoaded(); } };
}

function handleEvent(e, source) {
  switch (e.type) {
    case 'step':
      if (e.status === 'started') {
        logLine(`${ACTION_LABELS[e.step]}…`);
        if (e.step === 'generate') showMoment('generate');
        if (e.step === 'upload' || e.step === 'verify') showMoment('land');
      }
      break;
    case 'note': logLine(e.message, 'note'); break;
    case 'generated':
      showMoment('generate');
      startChart({ scales: e.scales, label: null });
      $('#pace').hidden = false;
      $('#pace').textContent = e.message;
      break;
    case 'day': addDay(e.row, e.feed); break;
    case 'upload-plan':
      showMoment('land');
      $('#land-dry').hidden = !ui.runDry;
      for (const [target, total] of Object.entries(e.totals)) setBucket(target, 0, total, e.destinations[target]);
      break;
    case 'progress':
      if (e.message) logLine(e.message);
      if (e.step === 'upload') setBucket(e.target, e.done, e.total);
      break;
    case 'verify': showMoment('land'); addVerifyRow(e); break;
    case 'sample': showSample(e); break;
    case 'done':
      logLine(`${ACTION_LABELS[e.action]}: done.`, 'done');
      source.close(); setRunning(false); refreshLoaded();
      break;
    case 'error':
      logLine(e.message, 'error');
      source.close(); setRunning(false); refreshLoaded();
      break;
    default: break;
  }
}

// ------------------------------------------------------------------ 2. the chart, counters and feed
const PANELS = [
  { key: 'learnersOnLessons7d', title: 'Learners who opened a lesson in the last 7 days', cls: '1', kind: 'line', unit: '' },
  { key: 'signIns', title: 'Sign-ins per day', cls: '2', kind: 'line', unit: '' },
  { key: 'cancellations', title: 'Subscriptions cancelled per day', cls: '3', kind: 'bar', unit: '' },
  { key: 'lessonP95Ms', title: 'Lesson pages: time the slowest 5% of requests took', cls: '4', kind: 'line', unit: 'ms', budget: 1000, budgetLabel: '1 s target' },
  { key: 'lessonErrorPct', title: 'Lesson pages: share of requests that failed', cls: '3', kind: 'line', unit: '%' },
];
const chart = { rows: [], scales: {}, totals: { requests: 0, started: 0, completed: 0 } };

function startChart({ scales, label }) {
  chart.rows = [];
  chart.scales = scales;
  chart.totals = { requests: 0, started: 0, completed: 0 };
  $('#feed').replaceChildren();
  $('#replay-label').hidden = !label;
  if (label) $('#replay-label').textContent = label;
  for (const id of ['#c-days', '#c-requests', '#c-started', '#c-completed']) $(id).textContent = '0';
  drawChart();
}
function addDay(row, feed) {
  chart.rows.push(row);
  chart.totals.requests += row.requests;
  chart.totals.started += row.lessonStarts;
  chart.totals.completed += row.lessonCompletions;
  $('#c-days').textContent = String(chart.rows.length);
  $('#c-requests').textContent = fmt(chart.totals.requests);
  $('#c-started').textContent = fmt(chart.totals.started);
  $('#c-completed').textContent = fmt(chart.totals.completed);
  drawChart();
  const list = $('#feed');
  for (const item of feed ?? []) {
    const raw = item.raw.map((line) => { try { return JSON.stringify(JSON.parse(line), null, 2); } catch { return line; } }).join('\n\n');
    const li = el('li', { class: item.failed ? 'failed' : '' },
      el('details', {}, el('summary', {}, el('span', { class: 'when', text: `${shortDate(item.ts)} ${item.ts.slice(11, 16)}` }), document.createTextNode(item.sentence)), el('pre', { text: raw })));
    list.prepend(li);
  }
  while (list.children.length > 60) list.lastElementChild.remove();
}
function niceMax(v) {
  if (!v) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v * 1.05) ?? v;
}
function drawChart() {
  const W = 760; const left = 52; const right = 16; const panelH = 72; const gap = 34; const top = 22;
  const H = top + PANELS.length * (panelH + gap) + 10;
  const days = 60;
  const x = (i) => left + (i / (days - 1)) * (W - left - right);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Week by week activity' });
  PANELS.forEach((panel, p) => {
    const y0 = top + p * (panelH + gap);
    const max = niceMax(Math.max(chart.scales?.[panel.key] ?? 0, panel.budget ? panel.budget * 1.1 : 0));
    const y = (v) => y0 + panelH - (v / max) * panelH;
    const last = chart.rows.at(-1);
    root.append(svg('text', { x: left, y: y0 - 8, class: 'panel-title' }, panel.title));
    if (last) root.append(svg('text', { x: W - right, y: y0 - 8, class: 'panel-value', 'text-anchor': 'end' }, `${fmt(last[panel.key])}${panel.unit ? ` ${panel.unit}` : ''}`));
    root.append(svg('line', { x1: left, x2: W - right, y1: y0 + panelH, y2: y0 + panelH, class: 'grid' }));
    root.append(svg('line', { x1: left, x2: W - right, y1: y0, y2: y0, class: 'grid' }));
    root.append(svg('text', { x: left - 6, y: y0 + 4, class: 'axis', 'text-anchor': 'end' }, fmt(max)));
    root.append(svg('text', { x: left - 6, y: y0 + panelH + 4, class: 'axis', 'text-anchor': 'end' }, '0'));
    if (panel.budget) {
      root.append(svg('line', { x1: left, x2: W - right, y1: y(panel.budget), y2: y(panel.budget), class: 'budget' }));
      root.append(svg('text', { x: left + 4, y: y(panel.budget) - 4, class: 'axis' }, panel.budgetLabel));
    }
    if (panel.kind === 'bar') {
      const bw = Math.max(2, (W - left - right) / days - 3);
      chart.rows.forEach((r, i) => { if (r[panel.key] > 0) root.append(svg('rect', { x: x(i) - bw / 2, y: y(r[panel.key]), width: bw, height: y0 + panelH - y(r[panel.key]), class: `f${panel.cls}` })); });
    } else if (chart.rows.length) {
      // a null value (no full week yet) is not drawn rather than drawn as zero
      let pen = 'M';
      const d = chart.rows.map((r, i) => {
        if (r[panel.key] === null || r[panel.key] === undefined) { pen = 'M'; return ''; }
        const seg = `${pen}${x(i).toFixed(1)},${y(r[panel.key]).toFixed(1)}`;
        pen = 'L';
        return seg;
      }).join('');
      if (d) root.append(svg('path', { d, class: `line s${panel.cls}` }));
    }
  });
  // weekly date ticks along the bottom
  const base = top + PANELS.length * (panelH + gap) - gap + 18;
  const firstDate = chart.rows[0]?.date;
  if (firstDate) {
    for (let i = 0; i < days; i += 7) {
      const date = new Date(Date.parse(`${firstDate}T00:00:00Z`) + i * 86_400_000).toISOString();
      root.append(svg('text', { x: x(i), y: base, class: 'axis', 'text-anchor': 'middle' }, shortDate(date)));
    }
  }
  $('#chart').replaceChildren(root);
}

async function replay() {
  try {
    const { replay: last } = await api('/api/replay');
    if (!last) { logLine('There is no loaded run to replay yet.', 'note'); return; }
    const max = (k) => Math.max(0, ...last.daily.map((d) => d[k] ?? 0));
    const title = ui.scenarios.find((s) => s.id === last.scenario)?.title ?? last.scenario;
    startChart({ scales: Object.fromEntries(PANELS.map((p) => [p.key, max(p.key)])), label: `Replay of the run loaded at ${longTime(last.at)} (${title}, start date ${last.anchor}) — from the saved generation statistics, not a new generation.` });
    $('#pace').hidden = true;
    setRunning(true);
    const feed = new Map(last.feed);
    for (const row of last.daily) {
      addDay(row, feed.get(row.day));
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (error) { logLine(error.message, 'error'); } finally { setRunning(false); }
}

// ------------------------------------------------------------------ 3. where it lands
function setBucket(target, done, total, destination) {
  const box = $(`.bucket[data-target="${target}"]`);
  if (!box) return;
  if (destination) box.querySelector('[data-key]').textContent = destination;
  box.querySelector('.bar span').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  box.querySelector('.b-count').textContent = `${fmt(done)} / ${fmt(total)}`;
}
function addVerifyRow(e) {
  const body = $('#verify-table tbody');
  if (e.target === 'state') body.replaceChildren();
  const want = e.expected;
  const verdict = want === null || want === undefined ? el('span', { text: '—' })
    : want === e.objects ? el('span', { class: 'v-ok', text: `${fmt(want)}, all there` })
      : el('span', { class: 'v-bad', text: `${fmt(want)} generated, ${fmt(e.objects)} found` });
  body.append(el('tr', {}, el('th', { scope: 'row', text: TARGET_LABELS[e.target] }), el('td', { class: 'num', text: fmt(e.objects) }), el('td', { text: e.firstDay ?? '—' }), el('td', { text: e.lastDay ?? '—' }), el('td', {}, verdict)));
}
function showSample(e) {
  $('#verify-source').textContent = e.source;
  $('#sample').hidden = false;
  $('#sample-key').textContent = e.key;
  const list = $('#sample-lines');
  list.replaceChildren();
  for (const line of e.lines) {
    let raw = line.raw;
    try { raw = JSON.stringify(JSON.parse(line.raw), null, 2); } catch { /* a CloudFront line stays as it is */ }
    list.append(el('li', {}, el('details', {}, el('summary', { text: line.sentence }), el('pre', { text: raw }))));
  }
}

// ------------------------------------------------------------------ 4. open the envelope
async function openEnvelope() {
  const loaded = ui.state?.loaded;
  const target = dryRun() ? ui.state?.dryRunGenerated ?? null : loaded;
  const scenario = target?.scenario ?? ui.selected;
  const when = target?.anchor ?? anchor();
  try {
    const reveal = await api(`/api/scenarios/${scenario}/reveal?anchor=${when}`);
    const recomputed = await sha256(canonicalJson({ anchor: reveal.anchor, scenario: reveal.definition, seed: reveal.seed }));
    const shown = JSON.parse(sessionStorage.getItem('shown') ?? '{}')[`${scenario}|${when}`];
    const reference = shown?.fingerprint ?? target?.fingerprint ?? null;
    const box = $('#match');
    box.replaceChildren();
    if (!reference) {
      box.className = 'match';
      box.append(document.createTextNode('No fingerprint was shown for this scenario and date on this page yet, so there is nothing to compare with.'));
    } else {
      const ok = reference === recomputed;
      box.className = `match ${ok ? 'ok' : 'bad'}`;
      box.append(el('strong', { text: ok ? 'The fingerprint matches.' : 'The fingerprint does NOT match.' }),
        document.createTextNode(ok
          ? ` This page recomputed it just now, in the browser, from the definition below, and it is the one ${shown ? 'shown before the demo' : 'recorded when the scenario was loaded'}: the simulator was told exactly this and nothing else.`
          : ' The definition below is not the one that was sealed.'),
        el('span', { class: 'fp', text: `Recomputed: ${grouped(recomputed)}` }),
        el('span', { class: 'fp', text: `${shown ? `Shown at ${longTime(shown.at)}` : 'Recorded at load'}: ${grouped(reference)}` }));
      if (loaded && loaded.scenario === scenario && loaded.anchor === when && !dryRun()) {
        box.append(el('span', { class: 'fp', text: `Loaded into AWS at ${longTime(loaded.at)}: ${loaded.fingerprint === recomputed ? 'the same fingerprint' : `a different fingerprint (${grouped(loaded.fingerprint)})`}` }));
      }
    }
    $('#reveal-title').textContent = reveal.definition.title;
    $('#reveal-description').textContent = reveal.definition.description;
    $('#reveal-plain').replaceChildren(...reveal.plain.map((t) => el('li', { text: t })));
    $('#reveal-expected').textContent = reveal.definition.expected_finding;
    $('#reveal-status').textContent = reveal.definition.status === 'verified'
      ? 'Checked in advance against the Governance Agent\'s own detection rules and thresholds (see Technical details).'
      : `Experimental: ${reveal.definition.experimental_reason}`;
    $('#reveal-verified').replaceChildren(...(reveal.definition.verified_against ?? []).map((v) => el('li', {}, el('code', { text: v.file }), document.createTextNode(` — ${v.threshold}`))));
    $('#reveal-canonical').textContent = reveal.canonical;
    $('#envelope').hidden = false;
  } catch (error) {
    $('#match').className = 'match bad';
    $('#match').textContent = error.message;
    $('#envelope').hidden = false;
  }
}

// ------------------------------------------------------------------ start
async function init() {
  for (const b of $$('.moments button')) b.addEventListener('click', () => showMoment(b.dataset.moment));
  for (const b of $$('[data-action]')) b.addEventListener('click', () => runAction(b.dataset.action));
  $('#load').addEventListener('click', () => runAction('load'));
  $('#replay').addEventListener('click', replay);
  $('#open-envelope').addEventListener('click', openEnvelope);
  $('#anchor').addEventListener('change', updateFingerprint);
  $('#dry-run').addEventListener('change', () => { $('#dry-indicator').hidden = !dryRun(); });
  const { scenarios, defaultAnchor, seed, confirmations } = await api('/api/scenarios');
  ui.scenarios = scenarios;
  ui.confirmations = confirmations;
  $('#seed').textContent = String(seed);
  $('#anchor').value = defaultAnchor;
  await refreshLoaded();
  ui.selected = ui.state?.loaded?.scenario ?? (scenarios.find((s) => s.cases?.length) ?? scenarios[0])?.id ?? null;
  renderCards();
  await updateFingerprint();
  drawChart();
  if (ui.state?.running) logLine(`'${ui.state.running.action}' is running from another window.`, 'note');
}
init().catch((error) => { document.body.prepend(el('p', { class: 'run-log line error', text: error.message })); });
