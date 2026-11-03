// "Samsung cast": older smart TVs (Samsung 2010-2014 AllShare, LG, Sony, Panasonic…)
// that have a DLNA / UPnP media player built in. HomeCable finds them on the home
// network (SSDP), hands them a stream address (AVTransport SetAVTransportURI + Play)
// and keeps asking what they're doing (GetTransportInfo / GetPositionInfo). It looks
// to the rest of the app exactly like a Chromecast session (see cast.js):
//   connect() launch() load({url, contentType, live, startAt, title}) play() pause()
//   seek(t) status() setVolume(v) stop()   events: 'media' {playerState,…}, 'closed'.
// Old TVs play MPEG-TS (H.264/MPEG-2 + AAC/AC-3/MP2) best, so the PC sends them that
// (server.js `fmt=ts`). No extra dependencies; nothing is installed on the TV.
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const { EventEmitter } = require('events');

const SSDP = { host: '239.255.255.250', port: 1900 };
const RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

const localIps = () => {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  return out;
};
const xmlText = (xml, tag) => { const m = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml || ''); return m ? unxml(m[1].trim()) : ''; };
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function get(url, ms = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: ms, headers: { 'User-Agent': 'HomeCable DLNA/1.0' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 512e3) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// A device description → what we need to drive it.
async function describe(location) {
  const { status, body } = await get(location);
  if (status !== 200 || !/MediaRenderer/i.test(body)) return null;
  const base = new URL(xmlText(body, 'URLBase') || location);
  const services = [...body.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => ({ type: xmlText(m[1], 'serviceType'), control: xmlText(m[1], 'controlURL') }));
  const avt = services.find((s) => /AVTransport/i.test(s.type));
  if (!avt) return null;
  const rc = services.find((s) => /RenderingControl/i.test(s.type));
  const abs = (u) => new URL(u, base).toString();
  const name = xmlText(body, 'friendlyName').replace(/^\[(TV|AV)\]\s*/i, '') || 'TV';
  const maker = xmlText(body, 'manufacturer');
  const model = [maker, xmlText(body, 'modelName') || xmlText(body, 'modelNumber')].filter(Boolean).join(' ');
  const udn = xmlText(body, 'UDN').replace(/^uuid:/i, '') || location;
  const modelName = xmlText(body, 'modelName') || xmlText(body, 'modelNumber');
  return { id: 'dlna:' + udn, kind: 'dlna', name, model, maker, modelName, year: tvYear(maker, modelName), label: tvLabel(maker, modelName), host: new URL(location).hostname, location, avt: abs(avt.control), avtType: avt.type || AVT, rc: rc ? abs(rc.control) : null, rcType: rc?.type || RC };
}

// "Samsung Smart TV · 2011" — Samsung's model codes carry the year as a letter
// (UN55D6050: D = 2011). Other makers just get their name.
const SAMSUNG_YEARS = { B: 2009, C: 2010, D: 2011, E: 2012, F: 2013, H: 2014, J: 2015, K: 2016, M: 2017, N: 2018 };
function tvYear(maker, modelName) {
  if (!/samsung/i.test(maker || '')) return null;
  const m = /^(?:UN|UE|UA|LN|LE|PN|PS|PE|KS|QN)\d{2}([A-Z])/i.exec(String(modelName || '').trim());
  return m ? SAMSUNG_YEARS[m[1].toUpperCase()] || null : null;
}
function tvLabel(maker, modelName) {
  const brand = /samsung/i.test(maker) ? 'Samsung' : /\blg\b/i.test(maker) ? 'LG' : /sony/i.test(maker) ? 'Sony' : /panasonic/i.test(maker) ? 'Panasonic' : /philips/i.test(maker) ? 'Philips' : /sharp/i.test(maker) ? 'Sharp' : /toshiba/i.test(maker) ? 'Toshiba' : /vizio/i.test(maker) ? 'Vizio' : /hisense/i.test(maker) ? 'Hisense' : /microsoft/i.test(maker) ? 'Xbox' : (maker || '').split(/\s+/)[0] || '';
  const y = tvYear(maker, modelName);
  return [brand ? `${brand} Smart TV` : 'Smart TV', y, modelName].filter(Boolean).join(' · ');
}

// Ask the network "any media players out there?" on every adapter (VPNs otherwise
// swallow multicast on Windows, like with mDNS in cast.js).
function discover(timeout = 3000) {
  return new Promise((resolve) => {
    const locations = new Set();
    const socks = [];
    const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${RENDERER}\r\nUSER-AGENT: HomeCable/1.0 UPnP/1.0\r\n\r\n`);
    const mine = new Set(localIps());
    for (const ip of [...mine, null]) {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', () => {});
        s.on('message', (buf, rinfo) => {
          if (mine.has(rinfo.address)) return; // this PC's own players (Windows Media Player…)
          const loc = /^location:\s*(\S+)/im.exec(buf.toString())?.[1];
          if (loc && /^http:\/\//i.test(loc)) locations.add(loc);
        });
        s.bind(0, ip || undefined, () => {
          try { s.setMulticastTTL(2); if (ip) s.setMulticastInterface(ip); } catch {}
          const send = () => { try { s.send(msg, SSDP.port, SSDP.host); } catch {} };
          send(); setTimeout(send, 700);
        });
        socks.push(s);
      } catch {}
    }
    setTimeout(async () => {
      for (const s of socks) { try { s.close(); } catch {} }
      const found = (await Promise.all([...locations].map((l) => describe(l).catch(() => null)))).filter(Boolean);
      const out = [];
      for (const d of found) if (!out.some((x) => x.id === d.id)) out.push(d);
      resolve(out.sort((a, b) => a.name.localeCompare(b.name)));
    }, timeout);
  });
}

// One SOAP call to the TV.
function soap(controlUrl, serviceType, action, args = {}, ms = 8000) {
  const body = `<?xml version="1.0" encoding="utf-8"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const u = new URL(controlUrl);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST', timeout: ms,
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${serviceType}#${action}"`, 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'HomeCable DLNA/1.0' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(Object.assign(new Error(`The TV said no to ${action} (${xmlText(b, 'errorDescription') || res.statusCode})`), { upnp: xmlText(b, 'errorCode') }))));
    });
    req.on('timeout', () => req.destroy(new Error('The TV didn’t answer')));
    req.on('error', reject);
    req.end(body);
  });
}
const hms = (t) => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const secs = (s) => { const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(s || '')); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

// How we describe a stream to the TV. Live and converted streams have no length and
// can't be seeked by bytes (DLNA.ORG_OP=00); "streaming" transfer mode.
function protocolInfo(contentType, seekable) {
  const flags = '01700000000000000000000000000000';
  const pn = contentType === 'video/mpeg' ? 'DLNA.ORG_PN=MPEG_TS_HD_NA_ISO;' : '';
  return `http-get:*:${contentType}:${seekable ? '' : pn}DLNA.ORG_OP=${seekable ? '01' : '00'};DLNA.ORG_CI=${seekable ? 0 : 1};DLNA.ORG_FLAGS=${flags}`;
}
function didl(url, { title, subtitle, contentType, seekable }) {
  const cls = /^audio/.test(contentType) ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/"><item id="hc1" parentID="0" restricted="1"><dc:title>${esc(title || 'HomeCable')}</dc:title>${subtitle ? `<dc:description>${esc(subtitle)}</dc:description>` : ''}<upnp:class>${cls}</upnp:class><res protocolInfo="${esc(protocolInfo(contentType, seekable))}">${esc(url)}</res></item></DIDL-Lite>`;
}

// ---------- a session with one DLNA TV ----------
class DlnaSession extends EventEmitter {
  constructor(device) {
    super();
    this.device = device;
    this.msid = 0;
    this.closed = false;
    this.fails = 0;
    this.loaded = false;
    this.lastState = '';
  }
  async connect() {
    // Is it really there and willing? (Also wakes up some sets' media player.)
    await soap(this.device.avt, this.device.avtType, 'GetTransportInfo', { InstanceID: 0 }, 6000);
    this.timer = setInterval(() => this.poll(), 1500);
  }
  async launch() {}

  async load({ url, contentType = 'video/mpeg', live, startAt = 0, title, subtitle }) {
    if (this.closed) throw new Error('Not connected to the TV');
    this.loaded = false;
    this.msid++;
    const seekable = !live && !/[?&]fmt=ts/.test(url) && !/\/(stream|live|mirror)\//.test(new URL(url).pathname + '/');
    try { await soap(this.device.avt, this.device.avtType, 'Stop', { InstanceID: 0 }, 4000); } catch {}
    await soap(this.device.avt, this.device.avtType, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl(url, { title, subtitle, contentType, seekable }) }, 15000);
    await soap(this.device.avt, this.device.avtType, 'Play', { InstanceID: 0, Speed: 1 }, 15000);
    this.loaded = true;
    this.loadedAt = Date.now();
    this.lastState = 'TRANSITIONING';
    this.sawPlaying = false;
    this.startAt = seekable && startAt > 1 ? startAt : 0;
    this.live = !seekable;
    this.emit('media', { playerState: 'BUFFERING', currentTime: 0, mediaSessionId: this.msid });
    return { mediaSessionId: this.msid };
  }

  async poll() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const ti = await soap(this.device.avt, this.device.avtType, 'GetTransportInfo', { InstanceID: 0 }, 5000);
      const state = xmlText(ti, 'CurrentTransportState');
      let t = null;
      try { t = secs(xmlText(await soap(this.device.avt, this.device.avtType, 'GetPositionInfo', { InstanceID: 0 }, 5000), 'RelTime')); } catch {}
      this.fails = 0;
      if (!this.loaded) return;
      if (state === 'PLAYING' && !this.sawPlaying) {
        this.sawPlaying = true;
        // Resume where you were (files only): seek once it has started.
        if (this.startAt) { const at = this.startAt; this.startAt = 0; this.seek(at); }
      }
      const map = { PLAYING: 'PLAYING', PAUSED_PLAYBACK: 'PAUSED', PAUSED_RECORDING: 'PAUSED', TRANSITIONING: 'BUFFERING', STOPPED: 'IDLE', NO_MEDIA_PRESENT: 'IDLE' };
      const ps = map[state] || 'BUFFERING';
      // Stopped after playing = it ran to the end (or the TV's own Stop was pressed).
      // Never started within 25 s of loading: the TV couldn't play it.
      const idleReason = ps === 'IDLE' ? (this.sawPlaying ? 'FINISHED' : Date.now() - this.loadedAt > 25000 ? 'ERROR' : 'NONE') : undefined;
      if (idleReason === 'ERROR') this.loaded = false;
      // Stopped on the TV (its own remote's Stop) during a live or converted stream: that's
      // "stop casting", not "the show ended" — otherwise HomeCable would start it again.
      if (ps === 'IDLE' && this.sawPlaying && this.live) { this.loaded = false; this.close('stopped on the TV'); return; }
      if (ps === 'IDLE' && this.sawPlaying) this.loaded = false;
      this.lastState = state;
      this.emit('media', { playerState: ps, idleReason, currentTime: t, mediaSessionId: this.msid });
    } catch {
      if (++this.fails >= 6) this.close('disconnected'); // ~10 s of no answer: the TV went away
    } finally {
      this.polling = false;
    }
  }

  play() { soap(this.device.avt, this.device.avtType, 'Play', { InstanceID: 0, Speed: 1 }).catch(() => {}); }
  pause() { soap(this.device.avt, this.device.avtType, 'Pause', { InstanceID: 0 }).catch(() => {}); }
  seek(t) { soap(this.device.avt, this.device.avtType, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(t) }).catch(() => {}); }
  status() { this.poll(); }
  setVolume(v) {
    if (!this.device.rc) return;
    const level = Math.round(Math.max(0, Math.min(1, (v && typeof v === 'object' ? v.level : v) ?? 0.5)) * 100);
    soap(this.device.rc, this.device.rcType, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: level }).catch(() => {});
  }
  async stop() {
    try { await soap(this.device.avt, this.device.avtType, 'Stop', { InstanceID: 0 }, 4000); } catch {}
    this.close('stopped');
  }
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.emit('closed', reason);
  }
}

module.exports = { discover, describe, DlnaSession, soap, didl, protocolInfo, tvYear, tvLabel };
