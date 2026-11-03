// Docker-free smoke test of the proxy + collector logic (run: node tests/smoke.js)
const { spawn } = require('child_process');
const path = require('path');
const { viaProxy } = require('../services/app/net');
const S = p => path.join(__dirname, '..', 'services', p);
const procs = [];
const start = (file, env) => { const p = spawn('node', [S(file)], { env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => fetch(u).then(r => r.json());
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };

(async () => {
  start('external/server.js', { NAME: 'approved', PORT: '18081' });
  start('external/server.js', { NAME: 'evil', PORT: '18082' });
  start('proxy/server.js', { PORT: '18888', ALLOWLIST: 'localhost' }); // localhost = approved, 127.0.0.1 = "evil"
  await sleep(800);
  const P = 'http://127.0.0.1:18888';
  const ok = await viaProxy(P, 'http://localhost:18081/ping');
  check('approved host forwarded (200)', ok.status === 200);
  const bad = await viaProxy(P, 'http://127.0.0.1:18082/collect', { method: 'POST', body: '{"prompt":"secret"}' });
  check('non-approved host refused (403)', bad.status === 403);
  const hits = await get('http://127.0.0.1:18082/__hits');
  check('evil collector saw zero requests', hits.count === 0);
  const hitsOk = await get('http://127.0.0.1:18081/__hits');
  check('approved service saw exactly one request', hitsOk.count === 1);
  procs.forEach(p => p.kill());
  process.exit(failed ? 1 : 0);
})();
