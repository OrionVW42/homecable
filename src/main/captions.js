// Live captions: speech → text on this PC, for anything playing (live TV included).
// whisper.cpp's small server runs locally with the bundled "base" model (nothing goes
// online). The screen sends short pieces of the sound it's playing (16 kHz mono PCM);
// each comes back as a line of text — in English when the speech is another language.
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

let proc = null, port = 0, ready = null, idleTimer = null;
let log = () => {};

// Packaged: resources/whisper; from source: vendor/whisper.
function dir() {
  const packed = process.resourcesPath ? path.join(process.resourcesPath, 'whisper') : null;
  if (packed && fs.existsSync(path.join(packed, 'whisper-server.exe'))) return packed;
  return path.join(__dirname, '..', '..', 'vendor', 'whisper');
}
const MODEL = 'ggml-base-q5_1.bin';
const available = () => !!process.env.HOMECABLE_FAKE_CAPTIONS || process.platform === 'win32' && fs.existsSync(path.join(dir(), 'whisper-server.exe')) && fs.existsSync(path.join(dir(), MODEL));

const freePort = () => new Promise((ok, bad) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', bad); });

function start() {
  if (ready) return ready;
  ready = (async () => {
    if (!available()) throw new Error('Live captions aren’t installed');
    port = await freePort();
    const d = dir();
    const threads = Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2)));
    proc = spawn(path.join(d, 'whisper-server.exe'), ['-m', path.join(d, MODEL), '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'auto', '-nt'], { cwd: d, windowsHide: true });
    proc.stderr.on('data', () => {}); proc.stdout.on('data', () => {});
    proc.on('exit', (code) => { log('captions engine stopped', code); proc = null; ready = null; });
    // Up once it answers.
    for (let i = 0; i < 60; i++) {
      if (!proc) throw new Error('The captions engine didn’t start');
      try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); if (r.status < 500) { log('captions engine ready on', port); return; } } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('The captions engine didn’t start');
  })();
  ready.catch(() => { stop(); });
  return ready;
}
function stop() { clearTimeout(idleTimer); if (proc) { try { proc.kill(); } catch {} } proc = null; ready = null; }
// Not used for a couple of minutes: free the memory.
function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(stop, 120e3); }

function wav(pcm16) {
  const b = Buffer.alloc(44 + pcm16.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm16.length, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(pcm16.length, 40);
  Buffer.from(pcm16).copy(b, 44);
  return b;
}

// Things the model "hears" in music or silence — never shown.
const JUNK = /^(\[.*\]|\(.*\)|♪+|thank you\.?|thanks for watching!?|you|\.+|-+|subtitles by .*|music)$/i;
function clean(text) {
  return String(text || '')
    .replace(/\[(BLANK_AUDIO|MUSIC|NO_SPEECH|INAUDIBLE)[^\]]*\]/gi, '')
    .replace(/\((music|applause|laughs?|silence)[^)]*\)/gi, '')
    .split(/\n+/).map((l) => l.trim()).filter((l) => l && !JUNK.test(l)).join(' ')
    .replace(/\s{2,}/g, ' ').trim();
}

// One piece of sound → text. translate: English text whatever's spoken.
async function transcribe(pcm, { translate = true, language = 'auto', prompt = '' } = {}) {
  // Tests: a stand-in engine that reports how much sound it was sent.
  if (process.env.HOMECABLE_FAKE_CAPTIONS) return `heard ${(pcm.length / 32000).toFixed(1)} seconds`;
  await start();
  touch();
  const t0 = Date.now();
  const form = new FormData();
  form.append('file', new Blob([wav(Buffer.from(pcm))], { type: 'audio/wav' }), 'a.wav');
  form.append('response_format', 'json');
  form.append('language', language);
  form.append('translate', translate ? 'true' : 'false');
  form.append('temperature', '0');
  if (prompt) form.append('prompt', String(prompt).slice(-200));
  const r = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('captions ' + r.status);
  const j = await r.json();
  const text = clean(j.text);
  if (process.env.HOMECABLE_CC_LOG) console.log(`[cc] ${(pcm.length / 32000).toFixed(1)}s → ${Date.now() - t0}ms ${JSON.stringify(text)}${text !== String(j.text || '').trim() ? '  (raw ' + JSON.stringify(String(j.text || '').trim()) + ')' : ''}`);
  return text;
}

module.exports = { available, transcribe, stop, start, setLog: (f) => { log = f; }, clean, wav };
