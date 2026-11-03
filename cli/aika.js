#!/usr/bin/env node
// AIKA MVP CLI
//   node cli/aika.js verify [--leak] [--keep] [--offline] [--model]
//   node cli/aika.js bundle [--model] [--skip-build]   (connected build machine)
//   node cli/aika.js verify-bundle [dir]    (isolated machine: integrity check only)
//   node cli/aika.js install [dir]          (isolated machine: check + load images)
//   node cli/aika.js dashboard [--open]     (read-only HTML overview of reports and bundle)
// --model : use a REAL local model (Ollama, baked into the bundle) instead of the stub.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderHtml } = require('./report');
const { buildManifest, verifyManifest, hostProbe } = require('./bundle');
const { buildDashboard } = require('./dashboard');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy.json'), 'utf8'));
const IMAGE = 'aika/node-services:0.1';
const MODEL_IMAGE = 'aika/model:0.1';
const MODEL_NAME = process.env.AIKA_MODEL || 'qwen2.5:0.5b';
const VERSION = '0.1.0';
const PROMPT = 'In one sentence, what is an air-gapped network?';
const args = process.argv.slice(2);
const cmd = args[0];
const LEAK = args.includes('--leak');
const KEEP = args.includes('--keep');
const OFFLINE = args.includes('--offline');
const MODEL = args.includes('--model');

const profileArgs = MODEL ? ['--profile', 'model'] : [];
const composeEnv = () => ({
  LEAK: LEAK ? '1' : '0', ALLOWLIST: policy.allowed_hosts.join(','),
  ...(MODEL ? { LLM_MODE: 'ollama', LLM_URL: 'http://model:11434', MODEL: MODEL_NAME } : {})
});
const dc = (a, env = {}) => execFileSync('docker', ['compose', '-f', COMPOSE, ...profileArgs, ...a], {
  encoding: 'utf8', maxBuffer: 20e6, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...composeEnv(), ...env }
});
const docker = a => execFileSync('docker', a, { encoding: 'utf8', maxBuffer: 20e6, stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (...a) => {
  const out = dc(['exec', '-T', 'app', 'node', 'app/probe.js', ...a]).trim().split('\n').pop();
  return JSON.parse(out);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jsonLines = t => t.split('\n').map(l => { try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; } }).filter(Boolean);
const imagePresent = tag => { try { docker(['image', 'inspect', tag]); return true; } catch { return false; } };
const neededImages = () => (MODEL ? [IMAGE, MODEL_IMAGE] : [IMAGE]);

async function verify() {
  const checks = [];
  const add = (id, title, pass, detail) => { checks.push({ id, title, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${title} — ${detail}`); };

  let hp = null;
  if (OFFLINE) {
    console.log('OFFLINE mode: no build, no pulls. Using images already on this machine.');
    const missing = neededImages().filter(t => !imagePresent(t));
    if (missing.length) {
      console.error(`Missing image(s): ${missing.join(', ')}. Run:  node cli/aika.js install`);
      process.exit(2);
    }
    hp = await hostProbe();
  }

  console.log(`Starting stack (${LEAK ? 'LEAKY' : 'clean'} app, ${MODEL ? 'REAL model ' + MODEL_NAME : 'stub model'}${OFFLINE ? ', offline' : ''})...`);
  // Never rebuild the model image if it already exists (the build needs internet and many GB of disk).
  const noBuild = OFFLINE || (MODEL && imagePresent(MODEL_IMAGE));
  dc(['up', '-d', noBuild ? '--no-build' : '--build', '--force-recreate']);
  let healthy = false;
  for (let i = 0; i < 30 && !healthy; i++) { try { healthy = probe('health').ok; } catch {} if (!healthy) await sleep(1000); }
  if (!healthy) { console.error('App did not become healthy.'); dc(['down', '-v']); process.exit(2); }

  if (OFFLINE) {
    add('offline-proof', 'This machine has no route to the public internet during the run', !hp.reachable,
      hp.reachable ? `reached ${hp.results.filter(r => r.reachable).map(r => r.target).join(', ')} — disconnect the machine and run again`
                   : `no outside connection possible (${hp.results.map(r => r.target + ' ' + r.error).join(', ')})`);
  }

  // 1. Functional (a real model needs time to start and to load into memory)
  if (MODEL) console.log('Waiting for the model to answer (first answer can take a minute on a CPU)...');
  let ask = { ok: false };
  const tries = MODEL ? 40 : 1;
  for (let i = 0; i < tries; i++) {
    try { ask = probe('ask', PROMPT); } catch (e) { ask = { ok: false, error: e.message }; }
    if (ask.ok) break;
    if (i < tries - 1) await sleep(3000);
  }
  const preview = ask.answer ? String(ask.answer).replace(/\s+/g, ' ').slice(0, 90) : '';
  add('functional', 'App answers using the local model', ask.ok, ask.ok ? `answer: "${preview}"` : `no answer (${ask.error || 'empty'})`);
  if (MODEL) {
    add('real-model', 'Answer comes from a real local model, not the stub', ask.ok && !String(ask.answer).startsWith('[stub-llm]'),
      `model ${MODEL_NAME} served by Ollama inside the isolated network`);
  }
  await sleep(2000); // let any background telemetry attempt finish

  // 2. Direct egress blocked
  const direct = policy.direct_probes.map(t => probe('direct', t));
  const reachable = direct.filter(d => d.reachable).map(d => d.target);
  add('direct-blocked', 'Direct outbound connections from the app are blocked', reachable.length === 0,
    reachable.length ? `REACHABLE: ${reachable.join(', ')}` : `all ${direct.length} direct probes failed (${direct.map(d => d.error).join(', ')})`);

  // 3. Approved destination works via proxy
  const ok = probe('proxied', policy.approved_url);
  add('allowed-works', 'Approved destination is reachable through the proxy', ok.status === 200, `status ${ok.status}`);

  // 4. Denied destination refused by proxy
  const bad = probe('proxied', policy.denied_url);
  add('denied-blocked', 'Non-approved destination is refused by the proxy', bad.status === 403, `status ${bad.status}`);

  // 5. Independent evidence: the outside collector never heard from the app
  const hitsRaw = dc(['exec', '-T', policy.collector_service, 'wget', '-qO-', 'http://127.0.0.1:8080/__hits']);
  const hits = JSON.parse(hitsRaw);
  add('collector-silent', 'Outside collector received zero requests', hits.count === 0, `collector saw ${hits.count} request(s)`);

  // Evidence logs
  const proxyLog = dc(['logs', '--no-color', '--no-log-prefix', 'proxy']);
  const appLog = dc(['logs', '--no-color', '--no-log-prefix', 'app']);
  const blockedEvents = jsonLines(proxyLog).filter(e => e.event === 'blocked');
  const appAttempts = jsonLines(appLog).filter(e => e.event === 'outbound_attempt');
  const attempts = [
    ...appAttempts.map(a => `app → ${a.dest} via ${a.route}: ${a.outcome}${a.error ? ' (' + a.error + ')' : ''}`),
    ...blockedEvents.map(b => `proxy refused ${b.method} to ${b.host}:${b.port}`)
  ];
  // The verifier's own denied probe shows up as one proxy refusal; do not count it as app behaviour.
  const appBlockedCount = appAttempts.length;

  const failed = checks.filter(c => !c.pass);
  let verdict;
  if (failed.length) verdict = `FAIL — ${failed.length} check(s) failed: ${failed.map(f => f.id).join(', ')}`;
  else if (appBlockedCount > 0) verdict = `CONTAINED — the app attempted ${appBlockedCount} unapproved connection(s); all were blocked and the outside collector saw nothing.`;
  else verdict = 'CLEAN — no unapproved connection attempts were observed from the app during these tests, and all containment checks passed.';

  const ts = new Date().toISOString();
  const dir = path.join(ROOT, 'artifacts', ts.replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proxy.log'), proxyLog);
  fs.writeFileSync(path.join(dir, 'app.log'), appLog);
  fs.writeFileSync(path.join(dir, 'collector_hits.json'), JSON.stringify(hits, null, 2));
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy, null, 2));

  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8' }).trim().split('\n')[0]; } catch { return 'unknown'; } };
  const limitations = [
    'The "outside world" in this run is simulated by services on a local Docker network, not the real internet.',
    'Only the paths listed in the checks were tested. A clean result does not prove that no other path exists.',
    'DNS-based leakage, covert channels, and host-level firewall behaviour were not tested.',
    'Isolation is container-level (Docker internal network); the host and Docker daemon are assumed trusted.',
    'This report is evidence for review, not a security certification or compliance statement.'
  ];
  limitations.push(MODEL
    ? `The model (${MODEL_NAME}) is a very small open-weight model, so answers are low quality. Its license must be checked before commercial use. The model container's own network behaviour is blocked by the internal network but not separately tested.`
    : 'The model in this run is a stub that returns canned answers. It is not a real AI model.');
  if (OFFLINE) limitations.push('The offline-proof check tests routes to two public addresses only. It does not prove the machine is physically disconnected.');
  const report = {
    timestamp: ts, mode: OFFLINE ? 'offline' : 'standard', leakVariant: LEAK, policy, verdict, checks, attempts,
    evidence: ['proxy.log', 'app.log', 'collector_hits.json', 'policy.json'],
    limitations,
    environment: {
      docker: sh('docker', ['--version']), node: process.version, platform: `${process.platform}/${process.arch}`,
      compose_sha256_prefix: sha(COMPOSE), policy_sha256_prefix: sha(path.join(ROOT, 'policy.json')),
      images: neededImages().join(', '), host_internet_probe: hp ? (hp.reachable ? 'reachable' : 'unreachable') : 'not run',
      model: MODEL ? `${MODEL_NAME} (real, via Ollama)` : 'stub (canned answers)'
    }
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'report.html'), renderHtml(report));

  console.log(`\nVERDICT: ${verdict}\nReport: ${path.join(dir, 'report.html')}`);
  if (!KEEP) dc(['down', '-v']);
  process.exit(failed.length ? 1 : 0);
}

async function bundle() {
  const out = path.join(ROOT, 'dist', `aika-bundle-${VERSION}${MODEL ? '-model' : ''}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const tags = neededImages();

  if (args.includes('--skip-build')) {
    const miss = tags.filter(t => !imagePresent(t));
    if (miss.length) { console.error(`--skip-build needs these images to exist already: ${miss.join(', ')}`); process.exit(2); }
    console.log('1/4 Skipping build; using images already on this machine.');
  } else {
    console.log(`1/4 Building image(s) (needs internet${MODEL ? '; downloads model ' + MODEL_NAME + ', this can take several minutes' : ' the first time'})...`);
    dc(['build']);
  }
  console.log('2/4 Exporting to images.tar (large when a model is included)...');
  docker(['save', '-o', path.join(out, 'images.tar'), ...tags]);
  const images = tags.map(tag => ({ tag, id: docker(['image', 'inspect', '--format', '{{.Id}}', tag]).trim(), archive: 'images.tar' }));

  console.log('3/4 Copying files...');
  for (const item of ['docker-compose.yml', 'policy.json', 'cli', 'services', 'tests', 'README.md']) {
    fs.cpSync(path.join(ROOT, item), path.join(out, item), { recursive: true });
  }
  const flag = MODEL ? ' --model' : '';
  fs.writeFileSync(path.join(out, 'README-OFFLINE.md'), `# AIKA offline bundle ${VERSION}${MODEL ? ` (with real local model: ${MODEL_NAME})` : ''}

Prerequisites on the isolated machine (install them separately from approved media): Docker with Compose v2, and Node.js 18+.

1. Check integrity (no network needed):   node cli/aika.js verify-bundle
2. Load the images:                        node cli/aika.js install
3. Run the checks with no internet:        node cli/aika.js verify --offline${flag}
   Leaky demo:                             node cli/aika.js verify --offline --leak${flag}
4. Read the results:                       node cli/aika.js dashboard --open

Compare the manifest fingerprint printed by step 1 with the one given to you on a separate channel.
Checksums catch corruption and accidental changes. They do NOT prove who made the bundle; signing is a later step.
${MODEL ? `The model (${MODEL_NAME}) is very small, so answers are low quality. Check its license before commercial use.\n` : ''}`);

  console.log('4/4 Writing manifest and checksums...');
  const { manifest, fingerprint } = await buildManifest(out, {
    name: 'aika', version: VERSION, images,
    model: MODEL ? { name: MODEL_NAME, runtime: 'ollama', image: MODEL_IMAGE } : null,
    built_with: { docker: docker(['--version']).trim(), node: process.version, platform: `${process.platform}/${process.arch}` }
  });
  console.log(`\nBundle ready: ${out}`);
  console.log(`Files: ${manifest.files.length}`);
  console.log(`Manifest fingerprint (sha256): ${fingerprint}`);
  console.log('Copy the whole folder to approved media, and share the fingerprint on a separate channel.');
}

async function checkBundle(dirArg) {
  const dir = path.resolve(dirArg || ROOT);
  const r = await verifyManifest(dir);
  if (r.error) { console.error(`FAIL  ${r.error} in ${dir}`); return r; }
  console.log(`Manifest fingerprint (sha256): ${r.fingerprint}`);
  console.log(`Files checked: ${r.manifest.files.length}`);
  if (r.manifest.model) console.log(`Includes real model: ${r.manifest.model.name} (${r.manifest.model.runtime})`);
  if (r.missing.length) console.log(`MISSING:    ${r.missing.join(', ')}`);
  if (r.mismatched.length) console.log(`CHANGED:    ${r.mismatched.join(', ')}`);
  if (r.extra.length) console.log(`UNLISTED:   ${r.extra.join(', ')}`);
  console.log(r.ok ? 'PASS  every file matches the manifest' : 'FAIL  bundle does not match its manifest — do not install');
  return r;
}

async function install(dirArg) {
  const dir = path.resolve(dirArg || ROOT);
  const r = await checkBundle(dir);
  if (!r.ok) process.exit(1);
  const tar = path.join(dir, 'images.tar');
  if (!fs.existsSync(tar)) { console.error('images.tar not found in bundle.'); process.exit(1); }
  console.log('Loading images into Docker (no network used; a bundle with a model is large, so this can take a few minutes)...');
  docker(['load', '-i', tar]);
  const wanted = (r.manifest.images || []).map(i => i.tag);
  const missing = wanted.filter(t => !imagePresent(t));
  if (missing.length) { console.error(`Image(s) not found after load: ${missing.join(', ')}`); process.exit(1); }
  for (const t of wanted) console.log(`PASS  image ${t} is loaded.`);
  const flag = r.manifest.model ? ' --model' : '';
  console.log(`Next: node cli/aika.js verify --offline${flag}`);
}

async function dashboard() {
  const out = path.join(ROOT, 'dashboard.html');
  fs.writeFileSync(out, await buildDashboard(ROOT));
  console.log(`Dashboard written: ${out}`);
  if (args.includes('--open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', out]] : process.platform === 'darwin' ? ['open', [out]] : ['xdg-open', [out]];
    try { execFileSync(opener[0], opener[1], { stdio: 'ignore' }); } catch { console.log('Could not open a browser automatically. Open the file by hand.'); }
  }
}

(async () => {
  try {
    if (cmd === 'verify') await verify();
    else if (cmd === 'bundle') await bundle();
    else if (cmd === 'verify-bundle') process.exit((await checkBundle(args[1])).ok ? 0 : 1);
    else if (cmd === 'install') await install(args[1]);
    else if (cmd === 'dashboard') await dashboard();
    else console.log('Usage:\n  node cli/aika.js verify [--leak] [--keep] [--offline] [--model]\n  node cli/aika.js bundle [--model] [--skip-build]\n  node cli/aika.js verify-bundle [dir]\n  node cli/aika.js install [dir]\n  node cli/aika.js dashboard [--open]');
  } catch (e) {
    console.error(e.stderr || e.message);
    if (cmd === 'verify' && !KEEP) { try { dc(['down', '-v']); } catch {} }
    process.exit(2);
  }
})();
