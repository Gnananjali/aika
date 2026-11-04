// Minimal pcap reader and summary. No dependencies.
// Reads a classic .pcap file (what `tcpdump -w` writes) and answers: who did this network namespace talk to?
//
// A pcap file = a 24-byte global header, then repeated [16-byte packet header + packet bytes].
// Each packet starts with a link-layer header (Ethernet, or Linux "cooked" capture when tcpdump uses -i any),
// then an IP header, then TCP or UDP. We only read the fields we need.

const DNS_TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 65: 'HTTPS' };

const v4 = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const v6 = (b, o) => { const g = []; for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(o + i).toString(16)); return g.join(':'); };

// "Local" = private, loopback, link-local, multicast, broadcast. Anything else counts as a public address.
function isLocalV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
}
function isLocalV6(b, o) {
  const first = b[o], second = b[o + 1];
  const zeros = [...b.subarray(o, o + 15)].every(x => x === 0);
  return (zeros && (b[o + 15] === 0 || b[o + 15] === 1)) || first === 0xfc || first === 0xfd || (first === 0xfe && (second & 0xc0) === 0x80) || first === 0xff;
}

// Find where the IP packet starts, depending on the link-layer type.
function ipOffset(pkt, linktype) {
  switch (linktype) {
    case 1: { // Ethernet
      if (pkt.length < 14) return null;
      let type = pkt.readUInt16BE(12), off = 14;
      if (type === 0x8100 && pkt.length >= 18) { type = pkt.readUInt16BE(16); off = 18; } // VLAN tag
      return { type, off };
    }
    case 113: // Linux cooked capture (tcpdump -i any, older)
      return pkt.length >= 16 ? { type: pkt.readUInt16BE(14), off: 16 } : null;
    case 276: // Linux cooked capture v2 (tcpdump -i any, newer)
      return pkt.length >= 20 ? { type: pkt.readUInt16BE(0), off: 20 } : null;
    case 101: { // raw IP
      if (pkt.length < 1) return null;
      const ver = pkt[0] >> 4;
      return { type: ver === 4 ? 0x0800 : ver === 6 ? 0x86dd : 0, off: 0 };
    }
    default: return null;
  }
}

// Read the first question of a DNS QUERY (not a response). Returns {name, type} or null.
function parseDnsQuery(b, off) {
  if (b.length < off + 12) return null;
  const flags = b.readUInt16BE(off + 2);
  if (flags & 0x8000) return null;               // a response, not a query
  if (b.readUInt16BE(off + 4) < 1) return null;  // no question
  let p = off + 12;
  const labels = [];
  while (p < b.length) {
    const len = b[p];
    if (len === 0) { p++; break; }
    if ((len & 0xc0) || p + 1 + len > b.length) return null;
    labels.push(b.toString('latin1', p + 1, p + 1 + len));
    p += len + 1;
  }
  if (p + 4 > b.length) return null;
  const qt = b.readUInt16BE(p);
  return { name: labels.join('.').toLowerCase(), type: DNS_TYPES[qt] || String(qt) };
}

function summarize(buf, opts = {}) {
  const ownProbe = new Set(opts.ownProbeIps || []);
  if (buf.length < 24) throw new Error('file too short to be a pcap');
  const magic = buf.readUInt32LE(0);
  let le;
  if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) le = true;
  else if (magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1) le = false;
  else throw new Error('not a classic pcap file (pcapng is not supported)');
  const u32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const linktype = u32(20);

  const tcp = new Map(), udp = new Map(), dns = new Map(), pub = new Set(), own = new Set();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let packets = 0, skipped = 0, off = 24;

  while (off + 16 <= buf.length) {
    const incl = u32(off + 8);
    off += 16;
    if (off + incl > buf.length) break;          // truncated last packet: stop quietly
    const pkt = buf.subarray(off, off + incl);
    off += incl;
    packets++;

    const l2 = ipOffset(pkt, linktype);
    if (!l2) { skipped++; continue; }
    let src, dst, proto, l4;
    if (l2.type === 0x0800 && pkt.length >= l2.off + 20) {
      const ihl = (pkt[l2.off] & 0x0f) * 4;
      proto = pkt[l2.off + 9];
      src = v4(pkt, l2.off + 12); dst = v4(pkt, l2.off + 16);
      l4 = l2.off + ihl;
      for (const ip of [src, dst]) if (!isLocalV4(ip)) (ownProbe.has(ip) ? own : pub).add(ip);
    } else if (l2.type === 0x86dd && pkt.length >= l2.off + 40) {
      proto = pkt[l2.off + 6];
      src = v6(pkt, l2.off + 8); dst = v6(pkt, l2.off + 24);
      l4 = l2.off + 40;
      if (!isLocalV6(pkt, l2.off + 8)) pub.add(src);
      if (!isLocalV6(pkt, l2.off + 24)) pub.add(dst);
    } else { skipped++; continue; }

    if (proto === 6 && pkt.length >= l4 + 14) {            // TCP
      const dport = pkt.readUInt16BE(l4 + 2), flags = pkt[l4 + 13];
      if ((flags & 0x02) && !(flags & 0x10)) bump(tcp, `${dst}:${dport}`); // SYN without ACK = a connection attempt
    } else if (proto === 17 && pkt.length >= l4 + 8) {     // UDP
      const sport = pkt.readUInt16BE(l4), dport = pkt.readUInt16BE(l4 + 2);
      bump(udp, `${dst}:${dport}`);
      if (dport === 53 || sport === 53) {
        const q = parseDnsQuery(pkt, l4 + 8);
        if (q) bump(dns, `${q.name}|${q.type}`);
      }
    }
  }

  const list = (m, f) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, count]) => f(k, count));
  return {
    packets, skipped, linktype,
    tcpConnections: list(tcp, (k, count) => ({ to: k, count })),
    udpDestinations: list(udp, (k, count) => ({ to: k, count })),
    dnsQueries: list(dns, (k, count) => { const [name, type] = k.split('|'); return { name, type, count }; }),
    publicAddresses: [...pub].sort(),
    ownProbeAddresses: [...own].sort()
  };
}

module.exports = { summarize, isLocalV4 };