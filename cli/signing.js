// Bundle signing with Ed25519, using Node's built-in crypto (no dependencies, works offline).
//
// Why: checksums in the manifest prove a bundle was not CHANGED after the manifest was written.
// They do not prove WHO wrote the manifest. A signature does: only the holder of the private key
// can produce a signature that verifies against the matching public key.
//
// Trust model: the public key (or its fingerprint) must reach the isolated site through a
// DIFFERENT channel than the bundle itself. If both arrive together, an attacker could swap both.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fingerprintOf = publicKeyObject =>
  crypto.createHash('sha256').update(publicKeyObject.export({ type: 'spki', format: 'der' })).digest('hex');

function generateKeys(dir, name = 'aika') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(dir, { recursive: true });
  const priv = path.join(dir, `${name}-private.pem`);
  const pub = path.join(dir, `${name}-public.pem`);
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { priv, pub, fingerprint: fingerprintOf(publicKey) };
}

// Fingerprint of the public key that belongs to a private key file (so we can print who signed).
function fingerprintOfPrivateKeyFile(privateKeyPath) {
  const priv = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
  return fingerprintOf(crypto.createPublicKey(priv));
}

function signFile(file, privateKeyPath, sigPath) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
  const signature = crypto.sign(null, fs.readFileSync(file), privateKey); // Ed25519 takes no separate hash
  fs.writeFileSync(sigPath, signature.toString('base64'));
  return fingerprintOf(crypto.createPublicKey(privateKey));
}

function verifyFile(file, sigPath, publicKeyPath) {
  if (!fs.existsSync(publicKeyPath)) return { ok: false, reason: `public key not found: ${publicKeyPath}` };
  if (!fs.existsSync(sigPath)) return { ok: false, reason: 'bundle has no manifest.sig (it is not signed)' };
  let publicKey;
  try { publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath)); }
  catch { return { ok: false, reason: 'public key file is not a valid key' }; }
  const signature = Buffer.from(fs.readFileSync(sigPath, 'utf8').trim(), 'base64');
  const ok = crypto.verify(null, fs.readFileSync(file), publicKey, signature);
  return { ok, fingerprint: fingerprintOf(publicKey), reason: ok ? 'signature matches' : 'signature does NOT match this key and manifest' };
}

module.exports = { generateKeys, signFile, verifyFile, fingerprintOfPrivateKeyFile };