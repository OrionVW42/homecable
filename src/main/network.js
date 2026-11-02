// Finds media on the local network:
//   * DLNA / UPnP media servers (NAS boxes, Plex, Jellyfin, Emby, Windows Media
//     sharing, many TVs) — SSDP discovery + ContentDirectory browsing
//   * Windows PCs (WS-Discovery) and NAS/Mac/Linux shares (mDNS _smb._tcp),
//     then their shared folders via `net view`
//   * this PC's drives, including mapped network drives
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SSDP_ADDR = '239.255.255.250';

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

// ---------- tiny XML helpers (DLNA responses are simple and regular) ----------
const decode = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i')); return m ? decode(m[1].trim()) : null; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}(\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi'))].map((m) => ({ attrs: m[1] || '', body: m[2] }));
const attr = (attrs, name) => { const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i')); return m ? decode(m[1]) : null; };

// ---------- SSDP / DLNA ----------
function ssdpSearch(st = 'urn:schemas-upnp-org:device:MediaServer:1', timeout = 3500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    const msg = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:1900`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${st}`, '', ''].join('\r\n'));
    // One socket per interface so multi-NIC PCs (VPNs, Hyper-V) still reach the LAN.
    for (const addr of [...lanAddresses(), null]) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {});
      s.on('message', (buf, rinfo) => {
        const text = buf.toString();
        const loc = text.match(/^location:\s*(.+)$/im)?.[1]?.trim();
        const usn = text.match(/^usn:\s*(.+)$/im)?.[1]?.trim();
        if (loc) found.set(usn || loc, { location: loc, ip: rinfo.address });
      });
      s.bind(0, addr || undefined, () => {
        try { if (addr) s.setMulticastInterface(addr); } catch {}
        s.send(msg, 1900, SSDP_ADDR, () => {});
        setTimeout(() => s.send(msg, 1900, SSDP_ADDR, () => {}), 800);
      });
      sockets.push(s);
    }
    setTimeout(() => { sockets.forEach((s) => { try { s.close(); } catch {} }); resolve([...found.values()]); }, timeout);
  });
}

async function describeDlna({ location }) {
  const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
  const xml = await res.text();
  const base = tag(xml, 'URLBase') || location;
  const services = tags(xml, 'service').map((s) => ({ type: tag(s.body, 'serviceType') || '', control: tag(s.body, 'controlURL') }));
  const cd = services.find((s) => /ContentDirectory/i.test(s.type));
  if (!cd) return null;
  const udn = tag(xml, 'UDN') || location;
  return {
    id: 'dlna:' + crypto.createHash('sha1').update(udn).digest('hex').slice(0, 10),
    kind: 'dlna', name: tag(xml, 'friendlyName') || new URL(location).hostname,
    detail: [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' · '),
    location, control: new URL(cd.control, base).href, serviceType: cd.type,
  };
}

async function discoverDlna(timeout) {
  const hits = await ssdpSearch(undefined, timeout);
  const out = await Promise.all(hits.map((h) => describeDlna(h).catch(() => null)));
  const seen = new Set();
  return out.filter((d) => d && !seen.has(d.id) && seen.add(d.id));
}

async function browse(server, objectId, start = 0, count = 200) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:Browse xmlns:u="${server.serviceType}"><ObjectID>${objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>` +
    `<StartingIndex>${start}</StartingIndex><RequestedCount>${count}</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
  const res = await fetch(server.control, {
    method: 'POST', body, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${server.serviceType}#Browse"` },
  });
  const xml = await res.text();
  const didl = tag(xml, 'Result') || '';
  const total = +(tag(xml, 'TotalMatches') || 0);
  const containers = tags(didl, 'container').map((c) => ({ id: attr(c.attrs, 'id'), title: tag(c.body, 'title') }));
  const items = tags(didl, 'item').map((it) => {
    const cls = tag(it.body, 'class') || '';
    const res = tags(it.body, 'res').map((r) => ({ url: decode(r.body.trim()), protocol: attr(r.attrs, 'protocolInfo') || '', duration: attr(r.attrs, 'duration'), size: +(attr(r.attrs, 'size') || 0), resolution: attr(r.attrs, 'resolution') }))
      .filter((r) => /^https?:/i.test(r.url));
    return { id: attr(it.attrs, 'id'), title: tag(it.body, 'title'), cls, art: tag(it.body, 'albumArtURI'), res };
  });
  return { containers, items, total };
}

const hms = (s) => { if (!s) return 0; const p = s.split(':').map(parseFloat); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0; };

// Walk a whole DLNA server. Returns flat media entries with a pseudo path made of
// the container titles (so show/season naming rules still apply).
async function crawlDlna(server, { onProgress, limit = 20000, deadline = Date.now() + 10 * 60e3 } = {}) {
  const out = [];
  const queue = [{ id: '0', path: [server.name] }];
  const seen = new Set();
  while (queue.length && out.length < limit && Date.now() < deadline) {
    const { id, path } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (let start = 0; ; start += 200) {
      let page;
      try { page = await browse(server, id, start); } catch { break; }
      for (const c of page.containers) if (c.id) queue.push({ id: c.id, path: [...path, c.title || '?'] });
      for (const it of page.items) {
        const r = it.res.find((x) => /video|audio/i.test(x.protocol)) || it.res[0];
        if (!r || !/videoItem|audioItem/i.test(it.cls)) continue;
        const mime = (r.protocol.split(':')[2] || '').toLowerCase();
        out.push({
          url: r.url, title: it.title, path: [...path, it.title].join('/'), mime, size: r.size, duration: hms(r.duration),
          resolution: r.resolution, audio: /audioItem/i.test(it.cls), movie: /movie/i.test(it.cls), art: it.art,
        });
      }
      onProgress?.(out.length, path.join(' / '));
      if (!page.containers.length && !page.items.length) break;
      if (start + 200 >= page.total) break;
    }
  }
  return out;
}

// ---------- Windows PCs (WS-Discovery) ----------
function wsDiscovery(timeout = 3500) {
  return new Promise((resolve) => {
    const ips = new Set();
    const probe = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:wsdp="http://schemas.xmlsoap.org/ws/2006/02/devprof"><soap:Header><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>urn:uuid:${crypto.randomUUID()}</wsa:MessageID></soap:Header><soap:Body><wsd:Probe><wsd:Types>wsdp:Device</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>`;
    const sockets = [];
    for (const addr of lanAddresses()) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {});
      s.on('message', (buf, rinfo) => { if (/ProbeMatch/i.test(buf.toString())) ips.add(rinfo.address); });
      s.bind(0, addr, () => { try { s.setMulticastInterface(addr); } catch {} s.send(probe, 3702, SSDP_ADDR, () => {}); });
      sockets.push(s);
    }
    setTimeout(() => { sockets.forEach((s) => { try { s.close(); } catch {} }); resolve([...ips]); }, timeout);
  });
}

// ---------- NAS / Mac / Linux (mDNS) ----------
function mdnsSmb(timeout = 3000) {
  return new Promise((resolve) => {
    let m;
    try { m = require('./cast').mdnsEverywhere(); } catch { return resolve([]); } // every adapter (VPNs can swallow plain queries)
    const hosts = new Map();
    m.on('response', (res) => {
      const recs = [...res.answers, ...(res.additionals || [])];
      for (const r of recs) {
        if (r.type === 'A') { const h = hosts.get(r.name) || {}; h.ip = r.data; hosts.set(r.name, h); }
        if (r.type === 'SRV' && /_smb\._tcp/.test(r.name)) { const h = hosts.get(r.data.target) || {}; h.name = r.name.split('._smb')[0]; hosts.set(r.data.target, h); }
      }
    });
    m.on('error', () => {});
    m.query({ questions: [{ name: '_smb._tcp.local', type: 'PTR' }] });
    setTimeout(() => {
      try { m.destroy(); } catch {}
      resolve([...hosts.entries()].filter(([, h]) => h.name || h.ip).map(([host, h]) => ({ host: host.replace(/\.local$/, ''), name: h.name || host, ip: h.ip })));
    }, timeout);
  });
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout))));
}

// Shared folders on a PC/NAS. Works for any host the current Windows user can reach.
async function listShares(host) {
  if (process.platform !== 'win32') return [];
  const out = await run('net', ['view', `\\\\${host}`, '/all']);
  const shares = [];
  let inTable = false;
  for (const line of out.split(/\r?\n/)) {
    if (/^-{5,}/.test(line)) { inTable = true; continue; }
    if (!inTable || !line.trim() || /command completed/i.test(line)) continue;
    const m = line.match(/^(.+?)\s{2,}(Disk|Print|IPC)\b/i);
    if (m && /disk/i.test(m[2]) && !/\$$/.test(m[1].trim())) shares.push({ name: m[1].trim(), path: `\\\\${host}\\${m[1].trim()}` });
  }
  return shares;
}

async function reverseName(ip) {
  try { const names = await require('dns').promises.reverse(ip); return names[0]?.split('.')[0] || ip; } catch { return ip; }
}

// ---------- this PC ----------
async function localDrives() {
  if (process.platform !== 'win32') return [{ path: '/', name: 'This computer', type: 'local' }];
  const json = await run('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_LogicalDisk | Select DeviceID,DriveType,VolumeName,ProviderName,Size,FreeSpace | ConvertTo-Json -Compress']);
  let disks = [];
  try { disks = [].concat(JSON.parse(json || '[]')); } catch {}
  const TYPE = { 2: 'removable', 3: 'local', 4: 'network', 5: 'disc' };
  return disks.filter((d) => TYPE[d.DriveType]).map((d) => ({
    path: d.DeviceID + '\\', type: TYPE[d.DriveType],
    name: `${d.VolumeName || (d.DriveType === 4 ? 'Network drive' : d.DriveType === 2 ? 'USB drive' : 'Local disk')} (${d.DeviceID})`,
    detail: d.ProviderName || (d.Size ? `${Math.round(d.Size / 1e9)} GB` : ''),
  }));
}

// Everything at once, for the setup wizard and Settings → Sources.
async function discoverAll({ timeout = 3500 } = {}) {
  const me = os.hostname().toLowerCase();
  const myIps = new Set(lanAddresses());
  const [dlna, wsd, mdns, drives] = await Promise.all([
    discoverDlna(timeout).catch(() => []), wsDiscovery(timeout).catch(() => []), mdnsSmb(timeout).catch(() => []), localDrives().catch(() => []),
  ]);
  const hosts = new Map();
  for (const ip of wsd) if (!myIps.has(ip)) hosts.set(ip, { ip, name: null });
  for (const h of mdns) if (!myIps.has(h.ip)) hosts.set(h.ip || h.host, { ip: h.ip, name: h.name, host: h.host });
  const pcs = await Promise.all([...hosts.values()].map(async (h) => {
    const name = h.name || await reverseName(h.ip);
    if (name.toLowerCase() === me) return null;
    const shares = await listShares(h.host || name !== h.ip ? (h.host || name) : h.ip);
    const viaIp = shares.length ? shares : await listShares(h.ip);
    return { id: 'smb:' + (h.ip || name), kind: 'smb', name, detail: h.ip, shares: viaIp };
  }));
  return {
    thisPc: { name: os.hostname(), drives },
    dlna,
    pcs: pcs.filter(Boolean),
  };
}

module.exports = { discoverAll, discoverDlna, crawlDlna, listShares, localDrives, browse, ssdpSearch };
