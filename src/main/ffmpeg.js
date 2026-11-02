// ffmpeg location + probing. We ship only ffmpeg (no ffprobe) and parse the
// stream summary that `ffmpeg -i` prints to stderr.
const { spawn } = require('child_process');

function ffmpegPath() {
  let p = require('ffmpeg-static');
  // In a packaged build the binary lives next to the installed app file, not
  // inside it — also when an updated app file runs from app-versions\<v>\.
  if (process.resourcesPath && /\.asar[\\/]/.test(p)) {
    const shellCopy = require('path').join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', require('path').basename(p));
    if (require('fs').existsSync(shellCopy)) return shellCopy;
  }
  return p.replace('app.asar' + require('path').sep, 'app.asar.unpacked' + require('path').sep);
}

function parseProbe(stderr) {
  const out = { duration: 0, container: '', video: null, audio: null, width: 0, height: 0, audioStreams: 0, title: '' };
  const fmt = stderr.match(/Input #0, ([^,\s]+(?:,[^,\s]+)*), from/);
  if (fmt) out.container = fmt[1];
  const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) out.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
  const t = stderr.match(/^\s{4}title\s*:\s*(.+)$/m);
  if (t) out.title = t[1].trim();
  for (const line of stderr.split(/\r?\n/)) {
    const m = line.match(/Stream #0:\d+.*?: (Video|Audio): (\w+)/);
    if (!m) continue;
    if (m[1] === 'Video') {
      // Cover art in mp3/m4a shows up as an attached-pic video stream.
      if (/attached pic/.test(line) || out.video) continue;
      out.video = m[2];
      const r = line.match(/, (\d{2,5})x(\d{2,5})/);
      if (r) { out.width = +r[1]; out.height = +r[2]; }
      if (/yuv4[24]\dp?1[02]|p10|10le/.test(line)) out.tenBit = true;
    } else {
      out.audioStreams++;
      if (!out.audio) out.audio = m[2];
    }
  }
  return out;
}

function probe(file, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let err = '';
    let done = false;
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    const timer = setTimeout(() => { if (!done) { p.kill(); } }, timeoutMs);
    p.stderr.on('data', (c) => { err += c; if (err.length > 200000) p.kill(); });
    p.on('error', () => { done = true; clearTimeout(timer); resolve(null); });
    p.on('close', () => {
      done = true; clearTimeout(timer);
      const r = parseProbe(err);
      resolve(r.duration > 0 || r.video || r.audio ? r : null);
    });
  });
}

// What can Chromium's <video> decode natively? Everything else gets remuxed
// (audio-only conversion) or fully transcoded.
const DIRECT_CONTAINERS = /^(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|mp3|ogg|flac|wav|aac)/;
const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);

function playMode(info) {
  if (!info) return 'transcode';
  const containerOk = DIRECT_CONTAINERS.test(info.container);
  const videoOk = !info.video || (DIRECT_VIDEO.has(info.video) && !(info.video === 'h264' && info.tenBit));
  const audioOk = !info.audio || DIRECT_AUDIO.has(info.audio);
  if (containerOk && videoOk && audioOk) return 'direct';
  // H.264 video is cheap to copy into fragmented mp4; only audio needs work.
  if (info.video === 'h264' && !info.tenBit) return 'remux';
  if (!info.video) return 'remux'; // audio-only: convert audio to aac
  return 'transcode';
}

let encoderCache = null;
// Probe for a working hardware H.264 encoder once; fall back to libx264.
async function pickEncoder() {
  if (encoderCache) return encoderCache;
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const ok = await new Promise((resolve) => {
      const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:d=0.2', '-c:v', enc, '-f', 'null', '-'], { windowsHide: true });
      const timer = setTimeout(() => p.kill(), 8000);
      p.on('error', () => { clearTimeout(timer); resolve(false); });
      p.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (ok) return (encoderCache = enc);
  }
  return (encoderCache = 'libx264');
}

function encoderArgs(enc) {
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-global_quality', '23', '-pix_fmt', 'nv12'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24', '-pix_fmt', 'yuv420p'];
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p'];
  }
}

// Args to stream `file` from `offset` seconds as fragmented MP4 on stdout.
function streamArgs(file, offset, mode, enc, info) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (/^https?:/i.test(file)) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (offset > 0) a.push('-ss', String(offset));
  a.push('-i', file);
  if (info && !info.video) {
    // Audio-only (cover art would otherwise sneak in as a video track).
    a.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    a.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    return a;
  }
  // Picture subtitles (DVD/Blu-ray) can't be shown as text: draw them onto the video.
  const aMap = `0:a:${info && info.track > 0 ? +info.track : 0}?`; // the chosen audio track (dub / original)
  if (info && info.burn != null) {
    a.push('-filter_complex', `[0:v:0][0:s:${+info.burn}]overlay=eof_action=pass,yadif=deint=interlaced,scale=w=min(1920\\,iw):h=-2[v]`, '-map', '[v]', '-map', aMap, '-sn', '-dn');
    a.push(...encoderArgs(enc), '-g', '60', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    a.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    return a;
  }
  a.push('-map', '0:v:0?', '-map', aMap, '-sn', '-dn');
  if (mode === 'remux') {
    a.push('-c:v', 'copy');
  } else {
    a.push(...encoderArgs(enc));
    // Keep it to 1080p max and deinterlace old DVD/TV captures.
    a.push('-vf', 'yadif=deint=interlaced,scale=w=min(1920\\,iw):h=-2');
    a.push('-g', '60');
  }
  a.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  a.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return a;
}

module.exports = { ffmpegPath, probe, parseProbe, playMode, pickEncoder, streamArgs };
