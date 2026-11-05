// HomeCable in your TV's own media menu: a small DLNA / UPnP media server. Older smart
// TVs (Samsung AllShare, LG, Sony, Panasonic…) list "HomeCable" next to USB sticks and
// other media servers; you browse it with the TV's own remote — Channels (in guide order,
// with what's on now), By genre, On Demand, Stream Demand — and press play. In the TV's
// player, next / previous (▶▶| |◀◀) moves to the next channel in the folder.
//
// Home network only (it answers on this PC's LAN addresses), and only while the setting
// is on. No pairing: anything a TV on your Wi-Fi can see is listed here, so it lists only
// what the current profile may watch, never the locked section.
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const SSDP = { host: '239.255.255.250', port: 1900 };
const TYPES = ['upnp:rootdevice', 'urn:schemas-upnp-org:device:MediaServer:1', 'urn:schemas-upnp-org:service:ContentDirectory:1', 'urn:schemas-upnp-org:service:ConnectionManager:1'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, t) => { const m = new RegExp(`<(?:[\\w-]+:)?${t}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${t}>`, 'i').exec(xml || ''); return m ? unxml(m[1].trim()) : ''; };

function lanAddrs() {
  const home = require('./vpn').homeNetworks();
  if (home.length) return home; // the home network only: never announced into a VPN
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name)) continue;
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a);
  }
  return out;
}
const toInt = (ip) => ip.split('.').reduce((n, p) => (n << 8) + (+p), 0) >>> 0;
function addrFor(remote) { // this PC's address on the same network as the TV
  const all = lanAddrs();
  const r = toInt(remote || '0.0.0.0');
  return (all.find((a) => ((toInt(a.address) & toInt(a.netmask)) >>> 0) === ((r & toInt(a.netmask)) >>> 0)) || all[0] || {}).address || '127.0.0.1';
}

const SCPD_CD = `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>
<action><name>Browse</name><argumentList><argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument><argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument><argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument><argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument><argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument><argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument><argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument><argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument><argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument><argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument></argumentList></action>
<action><name>GetSearchCapabilities</name><argumentList><argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument></argumentList></action>
<action><name>GetSortCapabilities</name><argumentList><argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument></argumentList></action>
<action><name>GetSystemUpdateID</name><argumentList><argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument></argumentList></action>
</actionList><serviceStateTable>
<stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType><allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList></stateVariable><stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable><stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable><stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable><stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
</serviceStateTable></scpd>`;
const SCPD_CM = `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>
<action><name>GetProtocolInfo</name><argumentList><argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument><argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument></argumentList></action>
<action><name>GetCurrentConnectionIDs</name><argumentList><argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument></argumentList></action>
</actionList><serviceStateTable><stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable><stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable></serviceStateTable></scpd>`;

const PI = {
  ts: 'http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_TS_HD_NA_ISO;DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  mp4: 'http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
};

// tree(id) → { id, parent, title, folder: true, children: () => [...] } | { id, parent, title, kind: 'ts'|'mp4', size?, duration? }
function createDms({ log = () => {}, name = 'HomeCable', node, stream, iconFile = null }) {
  const uuid = 'homecable-' + crypto.createHash('md5').update(os.hostname() + 'dms').digest('hex').slice(0, 24);
  let server = null, ssdp = null, notifyT = null, port = 0, updateId = 1;
  const desc = () => `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device>
<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC><friendlyName>${esc(name())}</friendlyName><manufacturer>HomeCable</manufacturer><manufacturerURL>https://github.com/OrionVW42/homecable</manufacturerURL><modelName>HomeCable</modelName><modelDescription>Your channels, live like cable</modelDescription><modelNumber>1</modelNumber><UDN>uuid:${uuid}</UDN>
${iconFile ? '<iconList><icon><mimetype>image/png</mimetype><width>120</width><height>120</height><depth>24</depth><url>/dms/icon.png</url></icon></iconList>' : ''}
<serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/dms/cd.xml</SCPDURL><controlURL>/dms/control/cd</controlURL><eventSubURL>/dms/event/cd</eventSubURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><SCPDURL>/dms/cm.xml</SCPDURL><controlURL>/dms/control/cm</controlURL><eventSubURL>/dms/event/cm</eventSubURL></service></serviceList></device></root>`;

  const soapOut = (res, service, action, body) => {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', EXT: '', Server: 'Windows UPnP/1.0 HomeCable/1.0' });
    res.end(`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}Response></s:Body></s:Envelope>`);
  };
  const soapFail = (res, code, text) => {
    res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
    res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${esc(text)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
  };
  const didlOf = (nodes, host) => `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${nodes.map((n) => n.folder
    ? `<container id="${esc(n.id)}" parentID="${esc(n.parent)}" restricted="1" childCount="${n.count ?? 0}" searchable="0"><dc:title>${esc(n.title)}</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>`
    : `<item id="${esc(n.id)}" parentID="${esc(n.parent)}" restricted="1"><dc:title>${esc(n.title)}</dc:title>${n.desc ? `<dc:description>${esc(n.desc)}</dc:description>` : ''}<upnp:class>object.item.videoItem${n.kind === 'ts' ? '.videoBroadcast' : ''}</upnp:class><res protocolInfo="${esc(PI[n.kind] || PI.ts)}"${n.size ? ` size="${n.size}"` : ''}${n.duration ? ` duration="${hms(n.duration)}"` : ''}>http://${host}:${port}/dms/play/${encodeURIComponent(n.id)}.${n.kind === 'mp4' ? 'mp4' : 'ts'}</res></item>`).join('')}</DIDL-Lite>`;
  const hms = (t) => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.000`; };

  async function onRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const host = addrFor(req.socket.remoteAddress?.replace(/^::ffff:/, ''));
    if (p === '/dms/desc.xml') { res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' }); return res.end(desc()); }
    if (p === '/dms/cd.xml') { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(SCPD_CD); }
    if (p === '/dms/cm.xml') { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(SCPD_CM); }
    if (p === '/dms/icon.png' && iconFile) { res.writeHead(200, { 'Content-Type': 'image/png' }); return require('fs').createReadStream(iconFile).pipe(res); }
    if (p.startsWith('/dms/event/')) { res.writeHead(200, { SID: 'uuid:' + crypto.randomUUID(), TIMEOUT: 'Second-1800' }); return res.end(); }
    if (p.startsWith('/dms/play/')) {
      const id = decodeURIComponent(p.slice('/dms/play/'.length)).replace(/\.(ts|mp4)$/, '');
      log(`tv menu: ${req.method}`);
      return stream(req, res, id);
    }
    if (req.method === 'POST' && p.startsWith('/dms/control/')) {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 64e3) req.destroy(); });
      await new Promise((r) => req.on('end', r));
      const action = (/#(\w+)"?\s*$/.exec(req.headers.soapaction || '') || [])[1] || '';
      if (p === '/dms/control/cm') {
        if (action === 'GetProtocolInfo') return soapOut(res, 'ConnectionManager', action, `<Source>${esc([PI.ts, PI.mp4].join(','))}</Source><Sink></Sink>`);
        if (action === 'GetCurrentConnectionIDs') return soapOut(res, 'ConnectionManager', action, '<ConnectionIDs>0</ConnectionIDs>');
        return soapFail(res, 401, 'Invalid Action');
      }
      if (action === 'GetSearchCapabilities') return soapOut(res, 'ContentDirectory', action, '<SearchCaps></SearchCaps>');
      if (action === 'GetSortCapabilities') return soapOut(res, 'ContentDirectory', action, '<SortCaps></SortCaps>');
      if (action === 'GetSystemUpdateID') return soapOut(res, 'ContentDirectory', action, `<Id>${updateId}</Id>`);
      if (action === 'Browse') {
        const id = tag(b, 'ObjectID') || '0';
        const flag = tag(b, 'BrowseFlag');
        const start = Math.max(0, parseInt(tag(b, 'StartingIndex'), 10) || 0);
        const want = Math.max(0, parseInt(tag(b, 'RequestedCount'), 10) || 0);
        const n = await node(id);
        if (!n) return soapFail(res, 701, 'No such object');
        if (flag === 'BrowseMetadata') {
          const one = n.folder ? { ...n, count: (await n.children()).length } : n;
          return soapOut(res, 'ContentDirectory', action, `<Result>${esc(didlOf([one], host))}</Result><NumberReturned>1</NumberReturned><TotalMatches>1</TotalMatches><UpdateID>${updateId}</UpdateID>`);
        }
        if (!n.folder) return soapFail(res, 710, 'Not a folder');
        const all = await n.children();
        const page = all.slice(start, want ? start + want : undefined);
        log(`tv menu: browse ${id} → ${page.length}/${all.length}`);
        return soapOut(res, 'ContentDirectory', action, `<Result>${esc(didlOf(page, host))}</Result><NumberReturned>${page.length}</NumberReturned><TotalMatches>${all.length}</TotalMatches><UpdateID>${updateId}</UpdateID>`);
      }
      return soapFail(res, 401, 'Invalid Action');
    }
    res.writeHead(404); res.end();
  }

  // ---- being found: answer "who's out there?" and say hello now and then ----
  const ntUsn = (nt) => (nt === `uuid:${uuid}` ? nt : `uuid:${uuid}::${nt}`);
  function notify(kind) {
    if (!ssdp) return;
    for (const a of lanAddrs()) for (const nt of [`uuid:${uuid}`, ...TYPES]) {
      const msg = Buffer.from(`NOTIFY * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://${a.address}:${port}/dms/desc.xml\r\nNT: ${nt}\r\nNTS: ssdp:${kind}\r\nSERVER: Windows/10 UPnP/1.0 HomeCable/1.0\r\nUSN: ${ntUsn(nt)}\r\n\r\n`);
      try { ssdp.setMulticastInterface(a.address); ssdp.send(msg, SSDP.port, SSDP.host); } catch {}
    }
  }
  function onSearch(buf, rinfo) {
    const t = buf.toString();
    if (!/^M-SEARCH/i.test(t)) return;
    const st = (/^st:\s*(.+)$/im.exec(t) || [])[1]?.trim();
    if (!st) return;
    const matches = st === 'ssdp:all' ? [`uuid:${uuid}`, ...TYPES] : [`uuid:${uuid}`, ...TYPES].includes(st) ? [st] : [];
    const at = addrFor(rinfo.address);
    for (const m of matches) {
      const msg = Buffer.from(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nDATE: ${new Date().toUTCString()}\r\nEXT:\r\nLOCATION: http://${at}:${port}/dms/desc.xml\r\nSERVER: Windows/10 UPnP/1.0 HomeCable/1.0\r\nST: ${m}\r\nUSN: ${ntUsn(m)}\r\nContent-Length: 0\r\n\r\n`);
      setTimeout(() => { try { ssdp.send(msg, rinfo.port, rinfo.address); } catch {} }, Math.random() * 400);
    }
  }

  async function start(wantPort = 47900) {
    if (server) return port;
    for (let i = 0; i < 10 && !server; i++) {
      const s = http.createServer((req, res) => onRequest(req, res).catch((e) => { log('tv menu', e.message); try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {} }));
      try { await new Promise((ok, no) => { s.once('error', no); s.listen(wantPort + i, '0.0.0.0', ok); }); server = s; port = wantPort + i; } catch {}
    }
    if (!server) throw new Error('Couldn’t open the TV menu');
    ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    ssdp.on('error', (e) => log('tv menu ssdp', e.message));
    ssdp.on('message', onSearch);
    await new Promise((ok) => ssdp.bind(SSDP.port, () => ok()));
    for (const a of lanAddrs()) { try { ssdp.addMembership(SSDP.host, a.address); } catch {} }
    try { ssdp.setMulticastTTL(4); } catch {}
    notify('alive');
    notifyT = setInterval(() => notify('alive'), 60e3);
    log(`tv menu: "${name()}" on port ${port} (${lanAddrs().map((a) => a.address).join(', ')})`);
    return port;
  }
  function stop() {
    clearInterval(notifyT);
    try { notify('byebye'); } catch {}
    try { ssdp?.close(); } catch {}
    try { server?.close(); server?.closeAllConnections?.(); } catch {}
    ssdp = null; server = null; port = 0;
  }
  return { start, stop, changed: () => { updateId++; }, port: () => port, uuid };
}

module.exports = { createDms };
