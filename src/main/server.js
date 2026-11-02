// Local media server for the player window (127.0.0.1 only, token-guarded).
// While casting, a second listener on the home network serves the same media to
// the Chromecast — media routes only, under a fresh random key per cast, and
// closed again as soon as casting stops.
//   /direct/:id          file as-is with Range support (formats Chromium decodes)
//   /stream/:id?t=&mode= ffmpeg remux/transcode from offset t, fragmented MP4
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffmpegPath, pickEncoder, streamArgs } = require('./ffmpeg');
const { liveArgs } = require('./iptv');

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm', mk3d: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', wav: 'audio/wav', ogv: 'video/ogg', '3gp': 'video/3gpp',
};

function startServer(lib, log = () => {}, { liveFor = () => null, thumbDir = null, posterFor = () => null, mirror = null, subtitleArgs = null } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  // One picture per screen: changing channels stops that screen's previous stream —
  // the PC (and the TV it casts to) is one screen, each paired phone is its own.
  const groups = new Map();
  const spawnTo = (args, res, req, type, label, group = 'pc') => {
    if (!groups.has(group)) groups.set(group, new Set());
    const streams = groups.get(group);
    for (const p of streams) p.kill('SIGKILL');
    streams.clear();
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    streams.add(p);
    let errText = '';
    p.stderr.on('data', (c) => { errText = (errText + c).slice(-2000); });
    p.on('close', (code) => { streams.delete(p); if (code && code !== 255 && !res.writableEnded) log(`ffmpeg exited ${code} (${label}): ${errText.trim()}`); });
    p.on('error', () => res.destroy());
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Cache-Control': 'no-store' });
    p.stdout.pipe(res);
    req.on('close', () => p.kill('SIGKILL'));
  };
  // Thumbnails: one frame grabbed by ffmpeg, cached on disk, two at a time.
  const thumbQueue = [];
  let thumbBusy = 0;
  const makeThumb = (item, out) => new Promise((resolve) => {
    thumbQueue.push(() => {
      thumbBusy++;
      const at = Math.max(1, Math.min(item.duration * 0.2, 300));
      const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(at), '-i', item.remote ? item.url : item.path, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', out], { windowsHide: true });
      // A failed spawn fires BOTH 'error' and 'close' — only count it once,
      // or the two-at-a-time cap drifts and the queue double-advances.
      let finished = false;
      const done = () => { if (finished) return; finished = true; thumbBusy--; resolve(fs.existsSync(out)); const nx = thumbQueue.shift(); if (nx) nx(); };
      const t = setTimeout(() => p.kill('SIGKILL'), 20000);
      p.on('close', () => { clearTimeout(t); done(); });
      p.on('error', () => { clearTimeout(t); done(); });
    });
    if (thumbBusy < 2) thumbQueue.shift()();
  });

  // who: { group, deny(item) } for other screens (phones); the PC itself uses the defaults.
  // Anything thrown mid-request (a file deleted between the exists check and the
  // stat, a probe that rejects) must still answer, or the player hangs forever.
  const serve = (req, res, url, who) => handle(req, res, url, who).catch((e) => {
    log('request failed', url.pathname, e.message);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {}
  });
  const handle = async (req, res, url, who = {}) => {
    const [, route, id] = url.pathname.split('/');
    const group = who.group || 'pc';
    if (route === 'live') {
      const st = liveFor(id, who);
      if (!st) { res.writeHead(404); return res.end(); }
      log(`live ${st.mode || 'copy'} ${st.url}${who.group ? ' → ' + who.group : ''}`);
      return spawnTo(liveArgs(st, st.mode || 'copy'), res, req, st.audioOnly ? 'audio/mp4' : 'video/mp4', 'live', group);
    }
    if (route === 'art') {
      // Movie posters (cached JPEGs made by artwork.js).
      const file = lib.items[id] && who.deny && who.deny(lib.items[id]) ? null : posterFor(id);
      if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const ict = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[String(file).split('.').pop().toLowerCase()] || 'image/jpeg';
      res.writeHead(200, { 'Content-Type': ict, 'Cache-Control': url.searchParams.get('p') === '1' ? 'no-store' : 'max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(file).pipe(res);
    }
    const item = lib.items[id] && !(who.deny && who.deny(lib.items[id])) ? lib.items[id] : null;
    if (route === 'thumb') {
      if (!item || !thumbDir || item.kind === 'music') { res.writeHead(404); return res.end(); }
      const out = path.join(thumbDir, id + '.jpg');
      if (!fs.existsSync(out) && !(await makeThumb(item, out))) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': url.searchParams.get('p') === '1' ? 'no-store' : 'max-age=86400', 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(out).pipe(res);
    }
    if (!item || (!item.remote && !fs.existsSync(item.path))) { res.writeHead(404); return res.end(); }

    if (route === 'frame') {
      // One small picture from any point in a video: the preview while you scrub.
      const t = Math.max(0, parseFloat(url.searchParams.get('t')) || 0);
      const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(t), '-i', item.remote ? item.url : item.path, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '6', '-f', 'mjpeg', 'pipe:1'], { windowsHide: true });
      const kill = setTimeout(() => p.kill('SIGKILL'), 10000);
      const chunks = [];
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('close', () => {
        clearTimeout(kill);
        if (!chunks.length) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': url.searchParams.get('p') === '1' || (who.deny && lib.items[id] && who.private?.(lib.items[id])) ? 'no-store' : 'max-age=3600', 'Access-Control-Allow-Origin': '*' });
        res.end(Buffer.concat(chunks));
      });
      p.on('error', () => { clearTimeout(kill); res.writeHead(404); res.end(); });
      req.on('close', () => p.kill('SIGKILL'));
      return;
    }

    if (route === 'direct' && item.remote) {
      // Network media server: pass the request through (keeps Range seeking, adds CORS).
      const up = (item.url.startsWith('https') ? require('https') : http).get(item.url, { headers: req.headers.range ? { Range: req.headers.range } : {} }, (r) => {
        const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': r.headers['content-type'] || 'application/octet-stream' };
        for (const k of ['content-length', 'content-range', 'accept-ranges']) if (r.headers[k]) h[k] = r.headers[k];
        res.writeHead(r.statusCode, h);
        r.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.on('close', () => up.destroy());
      return;
    }

    if (route === 'direct') {
      const size = fs.statSync(item.path).size;
      const type = MIME[path.extname(item.path).slice(1).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
      if (range) {
        const start = Math.max(0, range[1] ? +range[1] : size - +range[2]);
        const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(item.path, { start, end }).on('error', () => res.destroy()).pipe(res);
      } else {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
        fs.createReadStream(item.path).on('error', () => res.destroy()).pipe(res);
      }
      return;
    }

    if (route === 'subs') {
      // A subtitle track as WebVTT, lined up with a stream that starts at t.
      const t = Math.max(0, parseFloat(url.searchParams.get('t')) || 0);
      const args = subtitleArgs && (await subtitleArgs(id, url.searchParams.get('s'), t));
      if (!args) { res.writeHead(404); return res.end(); }
      const p = spawn(ffmpegPath(), args, { windowsHide: true });
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      p.stdout.pipe(res);
      p.on('error', () => res.end());
      req.on('close', () => p.kill('SIGKILL'));
      return;
    }
    if (route === 'stream') {
      const t = Math.max(0, parseFloat(url.searchParams.get('t')) || 0);
      const burn = url.searchParams.get('burn');
      const track = Math.max(0, parseInt(url.searchParams.get('audio'), 10) || 0);
      const mode = burn != null ? 'transcode' : url.searchParams.get('mode') === 'remux' ? 'remux' : 'transcode';
      const enc = mode === 'transcode' ? await pickEncoder() : null;
      const args = streamArgs(item.remote ? item.url : item.path, t, mode, enc, { video: item.kind === 'music' ? null : item.vcodec || '?', audio: item.acodec, burn: burn != null ? +burn : null, track });
      log(`stream ${mode}${enc ? '/' + enc : ''} t=${t.toFixed(1)} ${item.path}`);
      return spawnTo(args, res, req, item.kind === 'music' ? 'audio/mp4' : 'video/mp4', item.path, group);
    }
    res.writeHead(404); res.end();
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('k') !== token) { res.writeHead(403); return res.end(); }
    serve(req, res, url);
  });

  // ---- casting: the same media, reachable from the TV on the home network ----
  let castServer = null, castToken = null;
  const openCast = () => new Promise((resolve, reject) => {
    if (castServer) return resolve(castServer.address().port);
    castToken = crypto.randomBytes(24).toString('hex');
    castServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const route = url.pathname.split('/')[1];
      if (!castToken || url.searchParams.get('k') !== castToken || !['direct', 'stream', 'live', 'thumb', 'mirror'].includes(route)) { res.writeHead(403); return res.end(); }
      // Screen mirroring: the live picture of the whole HomeCable window.
      if (route === 'mirror') {
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' }); return res.end(); }
        log(`cast GET mirror from ${req.socket.remoteAddress}`);
        return mirror ? mirror(req, res) : (res.writeHead(404), res.end());
      }
      if (req.method === 'HEAD' && route !== 'direct' && route !== 'thumb') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' }); return res.end(); }
      log(`cast ${req.method} ${route} from ${req.socket.remoteAddress}${req.headers.range ? ' ' + req.headers.range : ''}`);
      serve(req, res, url);
    });
    castServer.on('error', (e) => { castServer = null; castToken = null; reject(e); });
    castServer.listen(0, '0.0.0.0', () => resolve(castServer.address().port));
  });
  const closeCast = () => { try { castServer?.close(); castServer?.closeAllConnections?.(); } catch {} castServer = null; castToken = null; };

  // ---- the phone app: paired phones on the home network (or over a VPN like Radmin) ----
  //   /phone/…      the phone app's screens (static files)
  //   /api/…        JSON for the phone (pairing, channels, remote control) — see main.js
  //   media routes  with the phone's own key (?k=), its own stream slot, locked items refused
  let phoneServer = null;
  const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
  const sendFile = (res, file) => {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': STATIC[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  };
  const openPhone = (port, { deviceFor, api, files, deny }) => new Promise((resolve, reject) => {
    if (phoneServer) return resolve(phoneServer.address().port);
    phoneServer = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
      const route = url.pathname.split('/')[1];
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (route === '' ) { res.writeHead(302, { Location: '/phone/' }); return res.end(); }
      if (route === 'phone') {
        // Only files inside the app folders — never anything else on the PC.
        const rel = decodeURIComponent(url.pathname.slice('/phone/'.length)) || 'index.html';
        return sendFile(res, files(rel));
      }
      if (route === 'api') {
        try { return await api(req, res, url); }
        catch (e) { log('phone api', e.message); if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); } return res.end(JSON.stringify({ error: 'Something went wrong' })); }
      }
      if (!['direct', 'stream', 'live', 'thumb', 'art', 'subs', 'frame'].includes(route)) { res.writeHead(404); return res.end(); }
      const dev = deviceFor(url.searchParams.get('k'));
      if (!dev) { res.writeHead(403); return res.end(); }
      serve(req, res, url, { group: 'phone:' + dev.id, deny: (it) => deny(it, dev), device: dev });
    });
    phoneServer.on('error', (e) => { phoneServer = null; reject(e); });
    phoneServer.listen(port, '0.0.0.0', () => resolve(phoneServer.address().port));
  });
  const closePhone = () => { try { phoneServer?.close(); phoneServer?.closeAllConnections?.(); } catch {} phoneServer = null; };
  // A player URL (127.0.0.1, window key) as the phone fetches it: relative path + the phone's key.
  const phonePath = (localUrl, key) => {
    if (!localUrl?.startsWith(base0())) return null;
    const u = new URL(localUrl);
    u.searchParams.set('k', key);
    return u.pathname + u.search;
  };
  let baseUrl = '';
  const base0 = () => baseUrl;

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      baseUrl = base;
      resolve({
        openPhone, closePhone, phonePath, phonePort: () => phoneServer?.address()?.port || null,
        server, token, base,
        urlFor: (id, { mode, t } = {}) => mode === 'direct'
          ? `${base}/direct/${id}?k=${token}`
          : `${base}/stream/${id}?k=${token}&mode=${mode}&t=${(t || 0).toFixed(2)}`,
        liveUrl: (chId, n = 0) => `${base}/live/${chId}?k=${token}&n=${n}`,
        thumbUrl: (id) => `${base}/thumb/${id}?k=${token}`,
        artUrl: (id) => `${base}/art/${id}?k=${token}`,
        subsUrl: (id, s, t = 0) => `${base}/subs/${id}?k=${token}&s=${encodeURIComponent(s)}&t=${(+t || 0).toFixed(2)}`,
        // Another audio track (dub) and/or picture subtitles drawn in: video copied when it can be.
        altUrl: (id, { burn = null, audio = 0, t = 0, remux = false } = {}) => `${base}/stream/${id}?k=${token}&mode=${burn == null && remux ? 'remux' : 'transcode'}&t=${(+t || 0).toFixed(2)}${burn != null ? `&burn=${+burn}` : ''}${audio > 0 ? `&audio=${+audio}` : ''}`,
        burnUrl: (id, n, t = 0) => `${base}/stream/${id}?k=${token}&mode=transcode&t=${(+t || 0).toFixed(2)}&burn=${+n}`,
        stopStreams: (group = 'pc') => { const s = groups.get(group); if (s) { for (const p of s) p.kill('SIGKILL'); s.clear(); } },
        openCast, closeCast,
        // Turn a player URL (127.0.0.1, window key) into one the TV can fetch.
        mirrorUrl: (lanIp) => (castServer && castToken ? `http://${lanIp}:${castServer.address().port}/mirror?k=${castToken}&t=${Date.now()}` : null),
        castUrl: (localUrl, lanIp) => {
          if (!castServer || !castToken || !localUrl?.startsWith(base)) return null;
          const u = new URL(localUrl);
          u.host = `${lanIp}:${castServer.address().port}`;
          u.searchParams.set('k', castToken);
          return u.toString();
        },
        contentTypeFor: (item) => MIME[path.extname(item.path || '').slice(1).toLowerCase()] || null,
      });
    });
  });
}

module.exports = { startServer };
