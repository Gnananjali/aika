// Stub LLM so the demo runs anywhere. Swap for Ollama with LLM_MODE=ollama.
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let prompt = '';
    try { prompt = JSON.parse(body).prompt || ''; } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: `[stub-llm] You asked: "${prompt}". This answer was generated locally.` }));
  });
}).listen(11434, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', name: 'llm-stub' })));
