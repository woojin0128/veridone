// Veridone — self-contained HTML value report (Pro feature).

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bars(obj, max = 10) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, max);
  const top = rows.length ? rows[0][1] : 1;
  if (!rows.length) return '<p class="muted">Nothing recorded in this period.</p>';
  return `<div class="bars">${rows.map(([k, v]) => `<div class="bar-row"><span class="bar-label">${esc(k)}</span><span class="bar-track"><span class="bar" style="width:${Math.max(4, Math.round((v / top) * 100))}%"></span></span><span class="bar-val">${v}</span></div>`).join('')}</div>`;
}

export function renderReportHtml(d) {
  const findings = Object.values(d.findings).reduce((a, b) => a + b, 0);
  const tiles = [
    ['Premature "done" caught', d.stopBlocks, 'Turns where Claude tried to finish without passing verification'],
    ['Cheats caught at edit time', findings, 'Skipped tests, deleted assertions, suppressions, placeholders'],
    ['Risky actions intercepted', d.denies + d.asks, `${d.denies} blocked · ${d.asks} confirmed with a human`],
    ['Tokens saved', d.tokensSaved.toLocaleString('en-US'), `${d.condensed} noisy outputs condensed`],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veridone value report</title>
<style>
:root { --bg:#f7f7f5; --card:#fff; --ink:#1d1d1b; --muted:#6b6b66; --line:#e6e4de; --accent:#2f6f4f; --accent-soft:#dcebe2; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --card:#1f1f1d; --ink:#ecebe6; --muted:#a3a29c; --line:#34332f; --accent:#7cc19b; --accent-soft:#223a2d; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 0 0 12px; }
.muted { color: var(--muted); }
.tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 24px 0; }
.tile, .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.tile .v { font-size: 30px; font-weight: 650; color: var(--accent); font-variant-numeric: tabular-nums; }
.tile .k { font-weight: 600; margin-top: 2px; }
.tile .d { color: var(--muted); font-size: 13px; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.bars { display:flex; flex-direction:column; gap:8px; }
.bar-row { display:grid; grid-template-columns: minmax(120px, 42%) 1fr 36px; gap:8px; align-items:center; font-size: 13px; }
.bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.bar-track { background: var(--accent-soft); border-radius: 6px; height: 10px; overflow: hidden; }
.bar { display:block; height:100%; background: var(--accent); border-radius: 6px; }
.bar-val { text-align:right; font-variant-numeric: tabular-nums; }
footer { margin-top: 28px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Veridone value report</h1>
  <div class="muted">Last ${esc(d.days)} days · ${esc(d.sessions)} Claude Code sessions · ${esc(d.projects)} project(s) · ${esc(d.files)} files changed · generated ${esc(new Date().toISOString().slice(0, 10))}</div>
  <section class="tiles">
    ${tiles.map(([k, v, desc]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div><div class="d">${esc(desc)}</div></div>`).join('')}
  </section>
  <section class="grid">
    <div class="card"><h2>Integrity findings by rule</h2>${bars(d.findings)}</div>
    <div class="card"><h2>Guard decisions by rule</h2>${bars(d.guards)}</div>
    <div class="card"><h2>Completion gate outcomes</h2>${bars(d.stopKinds)}</div>
    <div class="card"><h2>Verification</h2><p>${esc(d.verifications)} verification runs recorded, ${esc(d.failedVerifications)} failing. Every failing run after an edit is something Claude would otherwise have reported as done.</p></div>
  </section>
  <footer>Generated locally by Veridone from session ledgers on this machine. No data leaves the machine.</footer>
</main>
</body>
</html>
`;
}
