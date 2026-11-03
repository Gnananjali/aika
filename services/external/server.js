// Mock "outside world" service. Records every request it receives.
const http = require('http');
const NAME = process.env.NAME || 'external';
const PORT = +process.env.PORT || 8080;
const hits = [];
http.createServer((req, res) => {
  if (req.url === '/__hits') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ name: NAME, count: hits.length, hits }));
  }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    hits.push({ ts: new Date().toISOString(), method: req.method, url: req.url, from: req.socket.remoteAddress, bytes: body.length });
    console.log(JSON.stringify({ event: 'hit', name: NAME, method: req.method, url: req.url }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: NAME, ok: true }));
  });
}).listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', name: NAME, port: PORT })));
