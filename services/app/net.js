const http = require('http');
const { URL } = require('url');

// HTTP request sent THROUGH the proxy (absolute-URL form).
function viaProxy(proxyUrl, targetUrl, { method = 'GET', body, timeout = 4000 } = {}) {
  return new Promise(resolve => {
    const p = new URL(proxyUrl);
    const headers = { host: new URL(targetUrl).host };
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: p.hostname, port: p.port, method, path: targetUrl, headers, timeout }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, error: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
}
module.exports = { viaProxy };
