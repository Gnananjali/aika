// Read-only dashboard: one static HTML file. No scripts, no external requests, works offline.
const fs = require('fs');
const path = require('path');
const { sha256File } = require('./bundle');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function loadReports(root) {
  const dir = path.join(root, 'artifacts');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'report.json');
    if (fs.existsSync(f)) { try { out.push({ dir: d, ...JSON.parse(fs.readFileSync(f, 'utf8')) }); } catch {} }
  }
  return out.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function findManifest(root) {
  const direct = path.join(root, 'manifest.json');
  if (fs.existsSync(direct)) return direct;
  const dist = path.join(root, 'dist');
  if (fs.existsSync(dist)) {
    const dirs = fs.readdirSync(dist).filter(n => n.startsWith('aika-bundle-')).sort().reverse();
    for (const d of dirs) { const m = path.join(dist, d, 'manifest.json'); if (fs.existsSync(m)) return m; }
  }
  return null;
}

const verdictClass = v => (String(v).startsWith('FAIL') ? 'bad' : String(v).startsWith('CONTAINED') ? 'warn' : 'good');

function runCard(title, r, hint) {
  if (!r) return `<section class="card"><h2>${esc(title)}</h2><p class="muted">No run yet. ${esc(hint)}</p></section>`;
  const checks = r.checks.map(c => `<li class="${c.pass ? 'ok' : 'no'}"><span class="mark">${c.pass ? '✓' : '✗'}</span><span><b>${esc(c.title)}</b><br><span class="muted">${esc(c.detail)}</span></span></li>`).join('');
  const off = (r.checks.find(c => c.id === 'offline-proof'));
  const offline = off ? (off.pass ? 'Offline proof passed' : 'Offline proof FAILED') : 'Offline proof not run';
  return `<section class="card">
<h2>${esc(title)}</h2>
<div class="verdict ${verdictClass(r.verdict)}">${esc(r.verdict)}</div>
<div class="chips"><span class="chip">${esc(r.mode || 'standard')} mode</span><span class="chip">${r.leakVariant ? 'leaky app' : 'clean app'}</span><span class="chip">${esc(offline)}</span>${r.environment && r.environment.model ? `<span class="chip">model: ${esc(r.environment.model)}</span>` : ''}<span class="chip">${r.attempts.length} attempt record(s)</span></div>
<ul class="checks">${checks}</ul>
<p class="muted small">Run: ${esc(r.timestamp)}</p>
</section>`;
}

const diagram = `<svg viewBox="0 0 780 270" role="img" aria-label="AIKA architecture" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
<g class="d" font-size="13">
<rect x="10" y="85" width="150" height="90" rx="10" class="box"/><text x="85" y="118" text-anchor="middle" font-weight="600">Connected</text><text x="85" y="136" text-anchor="middle" font-weight="600">build machine</text><text x="85" y="158" text-anchor="middle" class="sub">builds bundle + manifest</text>
<line x1="160" y1="130" x2="215" y2="130" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/><text x="187" y="118" text-anchor="middle" class="sub">carry in</text>
<rect x="220" y="20" width="330" height="230" rx="14" class="zone"/><text x="235" y="42" class="sub">Isolated environment: no route out, no internet</text>
<rect x="240" y="70" width="110" height="60" rx="8" class="box"/><text x="295" y="105" text-anchor="middle" font-weight="600">AI app</text>
<rect x="240" y="150" width="110" height="60" rx="8" class="box"/><text x="295" y="185" text-anchor="middle" font-weight="600">Local model</text>
<line x1="295" y1="150" x2="295" y2="130" stroke="currentColor" stroke-width="1.5"/>
<rect x="420" y="95" width="110" height="70" rx="8" class="box"/><text x="475" y="125" text-anchor="middle" font-weight="600">Allowlist</text><text x="475" y="143" text-anchor="middle" font-weight="600">proxy</text>
<line x1="350" y1="100" x2="420" y2="115" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
<line x1="550" y1="115" x2="615" y2="75" stroke="#1a7f37" stroke-width="2" marker-end="url(#a)"/>
<line x1="550" y1="150" x2="615" y2="195" stroke="#b3261e" stroke-width="2" stroke-dasharray="5 4"/>
<rect x="620" y="45" width="150" height="60" rx="8" class="box"/><text x="695" y="72" text-anchor="middle" font-weight="600">Approved host</text><text x="695" y="90" text-anchor="middle" fill="#1a7f37">200 allowed</text>
<rect x="620" y="170" width="150" height="70" rx="8" class="box"/><text x="695" y="195" text-anchor="middle" font-weight="600">Outside collector</text><text x="695" y="213" text-anchor="middle" fill="#b3261e">403 blocked</text><text x="695" y="230" text-anchor="middle" class="sub">must receive 0</text>
</g></svg>`;

async function buildDashboard(root) {
  const reports = loadReports(root);
  const latestLeaky = reports.find(r => r.leakVariant);
  const latestClean = reports.find(r => !r.leakVariant);
  const latest = reports[0];

  let bundleHtml = '<p class="muted">No bundle found. Run <code>node cli/aika.js bundle</code> on the build machine.</p>';
  const mp = findManifest(root);
  if (mp) {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const fp = await sha256File(mp);
    const img = (m.images || []).map(i => esc(i.tag)).join(', ') || 'none';
    bundleHtml = `<table class="kv"><tr><td>Version</td><td>${esc(m.version)}</td></tr><tr><td>Created</td><td>${esc(m.created)}</td></tr><tr><td>Files in manifest</td><td>${m.files.length}</td></tr><tr><td>Images</td><td>${img}</td></tr><tr><td>Manifest fingerprint (sha256)</td><td><code>${esc(fp)}</code></td></tr></table>
<p class="muted small">Compare this fingerprint with the one shared on a separate channel. Checksums detect changes; they do not prove who made the bundle (signing is not built yet).</p>`;
  }

  const hist = reports.slice(0, 10).map(r => `<tr><td>${esc(r.timestamp)}</td><td>${esc(r.mode || 'standard')}</td><td>${r.leakVariant ? 'leaky' : 'clean'}</td><td class="${verdictClass(r.verdict)}t">${esc(String(r.verdict).split(' — ')[0])}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No runs yet.</td></tr>';
  const lims = (latest ? latest.limitations : [
    'No run recorded yet.']).map(l => `<li>${esc(l)}</li>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIKA Dashboard</title>
<style>
:root{--bg:#f6f8fa;--fg:#1b1b1b;--card:#fff;--line:#d0d7de;--muted:#57606a;--good:#1a7f37;--warn:#9a6700;--bad:#b3261e;--zone:#eef3f9;--accent:#1f3a5f}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--card:#161b22;--line:#30363d;--muted:#9aa4af;--good:#3fb950;--warn:#d29922;--bad:#f85149;--zone:#121a26;--accent:#7fb2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.5}
.wrap{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
h1{margin:0;color:var(--accent)}h2{margin:0 0 10px;font-size:1.05rem}.sub0{color:var(--muted);margin:2px 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.verdict{padding:10px 12px;border-left:6px solid;border-radius:6px;font-weight:600;background:var(--bg);margin-bottom:10px}
.verdict.good{border-color:var(--good)}.verdict.warn{border-color:var(--warn)}.verdict.bad{border-color:var(--bad)}
.goodt{color:var(--good);font-weight:600}.warnt{color:var(--warn);font-weight:600}.badt{color:var(--bad);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted)}
.checks{list-style:none;padding:0;margin:8px 0}.checks li{display:flex;gap:10px;padding:6px 0;border-top:1px solid var(--line)}
.mark{font-weight:700;width:16px}.ok .mark{color:var(--good)}.no .mark{color:var(--bad)}
.muted{color:var(--muted)}.small{font-size:12px}code{background:var(--bg);padding:1px 5px;border-radius:4px;word-break:break-all}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid var(--line);padding:6px 8px;text-align:left;font-size:14px;vertical-align:top}
th{color:var(--muted);font-weight:600}.kv td:first-child{width:38%;color:var(--muted)}
svg{width:100%;height:auto;color:var(--fg)}svg .box{fill:var(--card);stroke:var(--line);stroke-width:1.5}svg .zone{fill:var(--zone);stroke:var(--accent);stroke-width:1.5;stroke-dasharray:6 4}svg .sub{fill:var(--muted);font-size:11px}svg text{fill:var(--fg)}
.foot{color:var(--muted);font-size:12px;text-align:center;margin-top:20px}
</style></head><body><div class="wrap">
<h1>AIKA</h1><p class="sub0">Offline AI deployment and verification · read-only dashboard · generated ${esc(new Date().toISOString())}</p>
<section class="card"><h2>How it works</h2>${diagram}<p class="muted small">The app and model sit on a network with no route out. The proxy is the only way out and forwards approved hosts only. A separate collector must receive zero requests.</p></section>
<div class="grid">${runCard('Latest leaky-app run', latestLeaky, 'Run: node cli/aika.js verify --leak')}${runCard('Latest clean-app run', latestClean, 'Run: node cli/aika.js verify')}</div>
<div class="grid"><section class="card"><h2>Offline bundle</h2>${bundleHtml}</section>
<section class="card"><h2>Run history</h2><table><tr><th>Time</th><th>Mode</th><th>App</th><th>Verdict</th></tr>${hist}</table></section></div>
<section class="card"><h2>Limitations (what this does not show)</h2><ul>${lims}</ul><p class="muted small">This page only displays reports AIKA already wrote. It does not run tests, change policy, or contact any network. Each run card shows which model was used (a stub or a real local model).</p></section>
<p class="foot">No scripts · no external requests · works with the network disconnected</p>
</div></body></html>`;
}

module.exports = { buildDashboard };
