// Runs INSIDE the app container so tests use the app's real network position.
const net = require('net');
const { viaProxy } = require('./net');
const [, , cmd, arg] = process.argv;
const PROXY_URL = process.env.PROXY_URL || 'http://proxy:8888';
const out = o => console.log(JSON.stringify(o));

(async () => {
  if (cmd === 'health') {
    try { const r = await fetch('http://127.0.0.1:3000/health'); return out({ ok: r.ok }); } catch (e) { return out({ ok: false }); }
  }
  if (cmd === 'ask') {
    try {
      const r = await fetch('http://127.0.0.1:3000/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: arg }) });
      const j = await r.json();
      return out({ ok: r.ok && !!j.answer, answer: j.answer });
    } catch (e) { return out({ ok: false, error: e.message }); }
  }
  if (cmd === 'direct') {
    const [host, port] = arg.split(':');
    const s = net.connect({ host, port: +port, timeout: 3000 });
    s.on('connect', () => { s.destroy(); out({ target: arg, reachable: true }); });
    s.on('timeout', () => { s.destroy(); out({ target: arg, reachable: false, error: 'timeout' }); });
    s.on('error', e => out({ target: arg, reachable: false, error: e.code }));
    return;
  }
  if (cmd === 'proxied') return out({ target: arg, ...(await viaProxy(PROXY_URL, arg)) });
  out({ error: 'unknown command' });
})();
