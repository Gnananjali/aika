// Offline bundle helpers: manifest creation + integrity verification (no network, no dependencies).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const SKIP_IN_MANIFEST = new Set(['manifest.json', 'SHA256SUMS']);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

async function buildManifest(dir, meta = {}) {
  const files = [];
  for (const rel of walk(dir)) {
    if (SKIP_IN_MANIFEST.has(rel)) continue;
    const full = path.join(dir, rel);
    files.push({ path: rel, bytes: fs.statSync(full).size, sha256: await sha256File(full) });
  }
  const manifest = { format: 'aika-bundle/1', created: new Date().toISOString(), ...meta, files };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const manifestHash = await sha256File(path.join(dir, 'manifest.json'));
  const sums = files.map(f => `${f.sha256}  ${f.path}`).concat(`${manifestHash}  manifest.json`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums);
  return { manifest, fingerprint: manifestHash };
}

async function verifyManifest(dir) {
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) return { ok: false, error: 'manifest.json not found', missing: [], mismatched: [], extra: [] };
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const missing = [], mismatched = [];
  for (const f of manifest.files) {
    const full = path.join(dir, f.path);
    if (!fs.existsSync(full)) { missing.push(f.path); continue; }
    if (fs.statSync(full).size !== f.bytes || (await sha256File(full)) !== f.sha256) mismatched.push(f.path);
  }
  const listed = new Set(manifest.files.map(f => f.path));
  const IGNORE = p => p.startsWith('artifacts/') || p === 'dashboard.html';
  const extra = walk(dir).filter(p => !listed.has(p) && !SKIP_IN_MANIFEST.has(p) && !IGNORE(p));
  const fingerprint = await sha256File(mp);
  return { ok: !missing.length && !mismatched.length && !extra.length, missing, mismatched, extra, fingerprint, manifest };
}

// Does this machine have a route to the public internet? (tests two public addresses only)
function tcp(host, port, timeout = 2500) {
  return new Promise(resolve => {
    const target = `${host}:${port}`;
    const s = net.connect({ host, port, timeout });
    s.on('connect', () => { s.destroy(); resolve({ target, reachable: true }); });
    s.on('timeout', () => { s.destroy(); resolve({ target, reachable: false, error: 'timeout' }); });
    s.on('error', e => resolve({ target, reachable: false, error: e.code || e.message }));
  });
}
async function hostProbe() {
  const results = await Promise.all([tcp('1.1.1.1', 443), tcp('8.8.8.8', 53)]);
  return { reachable: results.some(r => r.reachable), results };
}

module.exports = { sha256File, walk, buildManifest, verifyManifest, hostProbe };
