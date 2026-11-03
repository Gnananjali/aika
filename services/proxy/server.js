// Minimal allowlist egress proxy. Logs every decision as JSON lines.
const http = require('http');
const net = require('net');
const { URL } = require('url');

const PORT = +process.env.PORT || 8888;
const ALLOW = (process.env.ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const log = o => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
const allowed = host => ALLOW.includes(String(host).toLowerCase());

const server = http.createServer((req, res) => {
  let t;
  try { t = new URL(req.url); } catch { res.writeHead(400); return res.end('absolute URL required'); }
  const base = { method: req.method, host: t.hostname, port: t.port || '80', from: req.socket.remoteAddress };
  if (!allowed(t.hostname)) {
    log({ event: 'blocked', ...base });
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'blocked by AIKA policy', host: t.hostname }));
  }
  log({ event: 'allowed', ...base });
  const up = http.request({
    hostname: t.hostname, port: t.port || 80, path: t.pathname + t.search,
    method: req.method, headers: { ...req.headers, host: t.host }
  }, ur => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on('error', e => { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(up);
});

server.on('connect', (req, sock, head) => {
  const [host, port] = req.url.split(':');
  const base = { method: 'CONNECT', host, port: port || '443', from: sock.remoteAddress };
  if (!allowed(host)) { log({ event: 'blocked', ...base }); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  log({ event: 'allowed', ...base });
  const s = net.connect(+port || 443, host, () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    s.write(head); s.pipe(sock); sock.pipe(s);
  });
  s.on('error', () => sock.end());
});

server.listen(PORT, '0.0.0.0', () => log({ event: 'listening', port: PORT, allowlist: ALLOW }));
