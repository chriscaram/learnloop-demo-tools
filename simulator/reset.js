// The presenter's reset page (/reset): one action, mark the AI agents' messages unread.
const $ = (s) => document.querySelector(s);
const target = () => document.querySelector('input[name="target"]:checked').value;

function say(text, kind = '') {
  const box = $('#result');
  box.textContent = text;
  box.className = `hint ${kind}`;
}

function describe(r) {
  const parts = Object.entries(r.byAgent ?? {}).map(([k, v]) => `${v} from ${k}`);
  return `${r.agentMessages} AI agent message(s) in ${r.stack}; ${r.reset} marked read${parts.length ? ` (${parts.join(', ')})` : ''}.`;
}

async function call(dryRun) {
  const res = await fetch('/api/reset-reads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: target(), dryRun, confirm: dryRun ? undefined : 'unread' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

$('#check').addEventListener('click', async () => {
  say('Checking…');
  try { say(describe(await call(true))); } catch (e) { say(e.message, 'error'); }
});

$('#reset').addEventListener('click', async () => {
  if (!window.confirm(`Mark every AI agent message unread in ${target()}?`)) return;
  say('Working…');
  try {
    const r = await call(false);
    say(r.written ? `Done. ${describe(r)} They are unread again.` : `Nothing to do. ${describe(r)}`);
  } catch (e) { say(e.message, 'error'); }
});
