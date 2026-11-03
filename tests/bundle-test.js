// Docker-free test of manifest creation and tamper detection (run: node tests/bundle-test.js)
const fs = require('fs'), os = require('os'), path = require('path');
const { buildManifest, verifyManifest } = require('../cli/bundle');
let failed = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aika-b-'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(d, 'sub')); fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'world');
  const { fingerprint } = await buildManifest(d, { name: 'test' });
  let r = await verifyManifest(d);
  check('clean bundle verifies', r.ok && r.fingerprint === fingerprint);
  fs.writeFileSync(path.join(d, 'a.txt'), 'HELLO');
  r = await verifyManifest(d);
  check('modified file is detected', !r.ok && r.mismatched.includes('a.txt'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello');
  fs.unlinkSync(path.join(d, 'sub', 'b.txt'));
  r = await verifyManifest(d);
  check('missing file is detected', !r.ok && r.missing.includes('sub/b.txt'));
  fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'world');
  fs.writeFileSync(path.join(d, 'extra.sh'), 'echo hi');
  r = await verifyManifest(d);
  check('unlisted extra file is detected', !r.ok && r.extra.includes('extra.sh'));
  fs.rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
