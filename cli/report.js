const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml(r) {
  const color = r.verdict.startsWith('FAIL') ? '#b3261e' : r.verdict.startsWith('CONTAINED') ? '#9a6700' : '#1a7f37';
  const rows = r.checks.map(c => `<tr><td>${c.pass ? '✅' : '❌'}</td><td>${esc(c.title)}</td><td>${esc(c.detail)}</td></tr>`).join('');
  const attempts = r.attempts.length
    ? r.attempts.map(a => `<li>${esc(a)}</li>`).join('')
    : '<li>None observed</li>';
  const c = r.capture;
  const capRows = (items, cols) => items.length ? items.map(i => `<tr>${cols.map(k => `<td>${esc(i[k])}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="muted">none</td></tr>`;
  const cap = c ? `<h2>Packet capture (inside the app's network namespace)</h2>
<p>${esc(c.packets)} packets captured. ${c.publicAddresses.length ? '<b>Public addresses seen: ' + esc(c.publicAddresses.join(', ')) + '</b>' : 'No packet involved a public IP address.'}${c.ownProbeAddresses.length ? ' The verifier itself probed ' + esc(c.ownProbeAddresses.join(', ')) + '.' : ''}</p>
<table><tr><th>DNS name looked up</th><th>Type</th><th>Count</th></tr>${capRows(c.dnsQueries, ['name', 'type', 'count'])}</table>
<table><tr><th>TCP connection attempts to</th><th>Count</th></tr>${capRows(c.tcpConnections, ['to', 'count'])}</table>` : '';
  const lims = r.limitations.map(l => `<li>${esc(l)}</li>`).join('');
  const env = Object.entries(r.environment).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIKA Verification Report</title>
<style>
body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1b1b1b;line-height:1.5}
h1{margin-bottom:4px}.verdict{padding:14px 16px;border-left:6px solid ${color};background:#f6f8fa;font-weight:600;margin:16px 0}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top;font-size:14px}
th{background:#f6f8fa}.muted{color:#57606a;font-size:13px}
</style></head><body>
<h1>AIKA Verification Report</h1>
<div class="muted">Policy: ${esc(r.policy.name)} • Run: ${esc(r.timestamp)} • Mode: ${esc(r.mode || 'standard')} • App variant: ${r.leakVariant ? 'LEAKY (test)' : 'CLEAN'}</div>
<div class="verdict">${esc(r.verdict)}</div>
<h2>Checks</h2><table><tr><th></th><th>Check</th><th>Result</th></tr>${rows}</table>
<h2>Unapproved connection attempts observed</h2><ul>${attempts}</ul>
<h2>Evidence files</h2><ul>${r.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
${cap}<h2>Limitations (what this report does NOT show)</h2><ul>${lims}</ul>
<h2>Environment</h2><table>${env}</table>
</body></html>`;
}
module.exports = { renderHtml };