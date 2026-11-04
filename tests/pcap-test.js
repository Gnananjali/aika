// Docker-free test of the pcap reader, using hand-built packets (run: node tests/pcap-test.js)
const { summarize } = require('../cli/pcap');
let failed = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };

const ip = s => Buffer.from(s.split('.').map(Number));
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const ipv4 = (proto, src, dst, payload) => Buffer.concat([
  Buffer.from([0x45, 0]), u16(20 + payload.length), u16(0), u16(0), Buffer.from([64, proto]), u16(0), ip(src), ip(dst), payload]);
const udp = (sport, dport, data) => Buffer.concat([u16(sport), u16(dport), u16(8 + data.length), u16(0), data]);
const tcp = (sport, dport, flags) => Buffer.concat([u16(sport), u16(dport), Buffer.alloc(8), Buffer.from([0x50, flags]), u16(8192), u16(0), u16(0)]);
const dnsQuery = name => Buffer.concat([
  u16(1234), u16(0x0100), u16(1), u16(0), u16(0), u16(0),
  ...name.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0]), u16(1), u16(1)]);

// link-layer wrappers
const ether = p => Buffer.concat([Buffer.alloc(12), u16(0x0800), p]);
const sll = p => Buffer.concat([Buffer.alloc(14), u16(0x0800), p]);              // 16-byte header
const sll2 = p => Buffer.concat([u16(0x0800), Buffer.alloc(18), p]);             // 20-byte header

function pcap(linktype, packets) {
  const g = Buffer.alloc(24);
  g.writeUInt32LE(0xa1b2c3d4, 0); g.writeUInt16LE(2, 4); g.writeUInt16LE(4, 6); g.writeUInt32LE(65535, 16); g.writeUInt32LE(linktype, 20);
  const parts = [g];
  for (const p of packets) { const h = Buffer.alloc(16); h.writeUInt32LE(p.length, 8); h.writeUInt32LE(p.length, 12); parts.push(h, p); }
  return Buffer.concat(parts);
}

const packets = wrap => [
  wrap(ipv4(17, '172.18.0.3', '127.0.0.11', udp(40000, 53, dnsQuery('evil-api')))),        // DNS query for evil-api
  wrap(ipv4(17, '172.18.0.3', '127.0.0.11', udp(40001, 53, dnsQuery('model')))),
  wrap(ipv4(6, '172.18.0.3', '172.18.0.5', tcp(50000, 8888, 0x02))),                        // SYN to proxy
  wrap(ipv4(6, '172.18.0.5', '172.18.0.3', tcp(8888, 50000, 0x12))),                        // SYN-ACK (reply, not an attempt)
  wrap(ipv4(6, '172.18.0.3', '172.18.0.5', tcp(50001, 8888, 0x02)))                         // second SYN to proxy
];

for (const [name, lt, wrap] of [['Ethernet', 1, ether], ['Linux cooked (SLL)', 113, sll], ['Linux cooked v2 (SLL2)', 276, sll2]]) {
  const s = summarize(pcap(lt, packets(wrap)));
  check(`${name}: counts all packets`, s.packets === 5);
  check(`${name}: finds DNS lookups`, s.dnsQueries.some(d => d.name === 'evil-api' && d.type === 'A') && s.dnsQueries.some(d => d.name === 'model'));
  check(`${name}: counts TCP connection attempts only (SYN without ACK)`, s.tcpConnections.length === 1 && s.tcpConnections[0].to === '172.18.0.5:8888' && s.tcpConnections[0].count === 2);
  check(`${name}: private traffic is not flagged as public`, s.publicAddresses.length === 0);
}

// public address detection, and the verifier's own probe targets
const withPublic = pcap(1, [...packets(ether), ether(ipv4(6, '172.18.0.3', '1.1.1.1', tcp(50002, 443, 0x02))), ether(ipv4(6, '172.18.0.3', '93.184.216.34', tcp(50003, 443, 0x02)))]);
let s = summarize(withPublic);
check('flags public addresses', s.publicAddresses.join() === '1.1.1.1,93.184.216.34');
s = summarize(withPublic, { ownProbeIps: ['1.1.1.1'] });
check("verifier's own probe target is reported separately, not as a leak", s.publicAddresses.join() === '93.184.216.34' && s.ownProbeAddresses.join() === '1.1.1.1');

// robustness
const good = pcap(1, packets(ether));
check('a truncated last packet does not crash', summarize(good.subarray(0, good.length - 10)).packets === 4);
let threw = false; try { summarize(Buffer.from('not a pcap file at all, just text....')); } catch { threw = true; }
check('a file that is not a pcap is rejected', threw);
process.exit(failed ? 1 : 0);