// Docker-free test: the app's Ollama mode talks to an Ollama-style API correctly.
// Uses a MOCK server, so it checks our request/response handling, not a real model.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
let failed = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let seen = null;
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    seen = { url: req.url, method: req.method, body: JSON.parse(b || '{}') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: 'An air-gapped network has no connection to the internet.' }));
  });
}).listen(21434, '127.0.0.1');
(async () => {
  await sleep(300);
  const app = spawn('node', [path.join(__dirname, '..', 'services', 'app', 'server.js')], {
    env: { ...process.env, PORT: '23000', LLM_MODE: 'ollama', LLM_URL: 'http://127.0.0.1:21434', MODEL: 'qwen2.5:0.5b', LEAK: '0' }, stdio: 'ignore'
  });
  await sleep(800);
  const r = await fetch('http://127.0.0.1:23000/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
  const j = await r.json();
  check('app returns the model answer', r.ok && j.answer.startsWith('An air-gapped'));
  check('calls /api/generate with POST', seen && seen.url === '/api/generate' && seen.method === 'POST');
  check('sends model name, prompt, stream=false', seen && seen.body.model === 'qwen2.5:0.5b' && seen.body.prompt === 'hi' && seen.body.stream === false);
  check('answer is not the stub text', !j.answer.startsWith('[stub-llm]'));
  app.kill(); mock.close();
  process.exit(failed ? 1 : 0);
})();
