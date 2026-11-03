// Docker-free test of bundle signing (run: node tests/signing-test.js)
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { buildManifest } = require('../cli/bundle');
const { generateKeys, signFile, verifyFile, fingerprintOfPrivateKeyFile } = require('../cli/signing');
const CLI = path.join(__dirname, '..', 'cli', 'aika.js');
let failed = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
const run = (...a) => spawnSync('node', [CLI, ...a], { encoding: 'utf8' });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aika-sig-'));
  const keysA = generateKeys(path.join(tmp, 'keysA'));
  const keysB = generateKeys(path.join(tmp, 'keysB'), 'other');
  const bundle = path.join(tmp, 'bundle');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'a.txt'), 'hello');
  await buildManifest(bundle, { name: 'test' });
  const manifest = path.join(bundle, 'manifest.json'), sig = path.join(bundle, 'manifest.sig');

  const fp = signFile(manifest, keysA.priv, sig);
  check('signing returns the signer key fingerprint', fp === keysA.fingerprint && fp === fingerprintOfPrivateKeyFile(keysA.priv));
  check('correct public key verifies the signature', verifyFile(manifest, sig, keysA.pub).ok);
  check('a different public key is rejected', !verifyFile(manifest, sig, keysB.pub).ok);

  // CLI: verify-bundle with and without the key, and the extra-file rule for manifest.sig
  let r = run('verify-bundle', bundle, '--pubkey', keysA.pub);
  check('CLI: signed bundle + right key -> exit 0', r.status === 0 && /PASS  signature/.test(r.stdout));
  r = run('verify-bundle', '--pubkey', keysB.pub, bundle); // flag before the folder also works
  check('CLI: wrong key -> exit 1', r.status === 1 && /FAIL  signature/.test(r.stdout));
  r = run('verify-bundle', bundle);
  check('CLI: no key given -> still exit 0, but says who-made-it is unchecked', r.status === 0 && /NOTE  this bundle is signed/.test(r.stdout));
  check('manifest.sig is not reported as an unlisted file', !/UNLISTED/.test(r.stdout));

  // tampering with the manifest breaks the signature (an attacker cannot edit hashes and keep the signature)
  const original = fs.readFileSync(manifest, 'utf8');
  fs.writeFileSync(manifest, original.replace('"test"', '"evil"'));
  check('edited manifest fails signature check', !verifyFile(manifest, sig, keysA.pub).ok);
  fs.writeFileSync(manifest, original);

  // unsigned bundle
  fs.unlinkSync(sig);
  const un = verifyFile(manifest, sig, keysA.pub);
  check('unsigned bundle fails when a key is required', !un.ok && /not signed/.test(un.reason));
  r = run('verify-bundle', bundle, '--pubkey', keysA.pub);
  check('CLI: unsigned bundle with --pubkey -> exit 1', r.status === 1);

  // keygen command
  const kdir = path.join(tmp, 'cli-keys');
  r = run('keygen', kdir);
  check('CLI: keygen writes both key files and prints a fingerprint',
    r.status === 0 && fs.existsSync(path.join(kdir, 'aika-private.pem')) && fs.existsSync(path.join(kdir, 'aika-public.pem')) && /fingerprint/.test(r.stdout));

  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();