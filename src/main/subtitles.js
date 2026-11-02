// Subtitles: every track in the file (ASS/SRT text, or DVD/Blu-ray picture subtitles)
// plus subtitle files next to it ("Movie.en.srt", "Subs/English.eng.srt"). Text tracks
// are turned into WebVTT for the player; picture tracks are burned into the video.
// "Auto" turns subtitles on when the audio is in another language (Japanese → English).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg');

const TEXT = new Set(['ass', 'ssa', 'subrip', 'srt', 'mov_text', 'webvtt', 'text', 'microdvd', 'subviewer', 'eia_608']);
const IMAGE = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'pgssub', 'dvdsub']);
const SUB_EXT = ['.srt', '.ass', '.ssa', '.vtt'];
// 2- and 3-letter language codes → the 3-letter ones files use.
const LANG3 = { en: 'eng', ja: 'jpn', jp: 'jpn', es: 'spa', fr: 'fra', fre: 'fra', de: 'deu', ger: 'deu', it: 'ita', pt: 'por', ru: 'rus', zh: 'zho', chi: 'zho', ko: 'kor', ar: 'ara', nl: 'nld', dut: 'nld', pl: 'pol', sv: 'swe', no: 'nor', nb: 'nob', da: 'dan', fi: 'fin', tr: 'tur', el: 'ell', gre: 'ell', he: 'heb', hi: 'hin', id: 'ind', th: 'tha', vi: 'vie', cs: 'ces', cze: 'ces', hu: 'hun', ro: 'ron', rum: 'ron', uk: 'ukr' };
const NAME3 = { english: 'eng', japanese: 'jpn', spanish: 'spa', 'español': 'spa', french: 'fra', 'français': 'fra', german: 'deu', deutsch: 'deu', italian: 'ita', italiano: 'ita', portuguese: 'por', 'português': 'por', russian: 'rus', chinese: 'zho', korean: 'kor', arabic: 'ara', dutch: 'nld', nederlands: 'nld' };
const lang3 = (s) => { s = String(s || '').toLowerCase(); if (s === 'und' || s === 'unk' || s === 'mis') return ''; return LANG3[s] || (s.length === 3 ? s : '') || NAME3[s] || ''; };

// Probe the file's audio and subtitle tracks (ffmpeg prints them; titles follow as metadata).
function probeTracks(file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stderr.on('data', (c) => { err += c; if (err.length > 400000) p.kill(); });
    const done = () => {
      clearTimeout(t);
      const audio = [], subs = [], chapters = [];
      let last = null;
      for (const line of err.split(/\r?\n/)) {
        const ch = /Chapter #\d+:\d+: start (-?[\d.]+), end ([\d.]+)/.exec(line);
        if (ch) { last = { start: +ch[1], end: +ch[2], title: '' }; chapters.push(last); continue; }
        const m = /Stream #0:\d+(?:\[0x[0-9a-f]+\])?(?:\((\w+)\))?: (Audio|Subtitle): ([\w-]+)(.*)$/.exec(line);
        if (m) {
          const lang = lang3(m[1]);
          const tr = { lang, codec: m[3], default: /\(default\)/.test(m[4]), forced: /\(forced\)/.test(m[4]), title: '' };
          if (m[2] === 'Audio') { tr.n = audio.length; audio.push(tr); }
          else { tr.n = subs.length; tr.image = IMAGE.has(m[3]); tr.text = TEXT.has(m[3]); subs.push(tr); }
          last = tr;
          continue;
        }
        if (/Stream #0:/.test(line)) { last = null; continue; }
        const ti = /^\s+title\s*:\s*(.+)$/.exec(line);
        if (ti && last && !last.title) last.title = ti[1].trim();
      }
      resolve({ audio, subs, chapters });
    };
    p.on('close', done);
    p.on('error', () => { clearTimeout(t); resolve({ audio: [], subs: [], chapters: [] }); });
  });
}

// Subtitle files next to the video: "Movie.srt", "Movie.en.srt", "Movie.English.forced.srt",
// and a "Subs" folder (its files belong to the video when it's alone in its folder or the
// names start with the video's name).
function externalSubs(videoPath, videosInFolder = 1) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const out = [];
  const look = (d, mustMatch) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const ext = path.extname(n).toLowerCase();
      if (!SUB_EXT.includes(ext)) continue;
      const stem = n.slice(0, -ext.length);
      if (mustMatch && !stem.toLowerCase().startsWith(base)) continue;
      const rest = mustMatch ? stem.slice(base.length) : stem;
      const tokens = rest.split(/[.\s_()[\]-]+/).filter(Boolean);
      const lang = tokens.map(lang3).find(Boolean) || '';
      const forced = tokens.some((x) => /^forced$/i.test(x));
      const sdh = tokens.some((x) => /^(sdh|cc|hi)$/i.test(x));
      out.push({ file: path.join(d, n), lang, forced, sdh, title: rest.replace(/^[.\s_-]+/, '').replace(/\.[a-z]{2,3}$/i, '') || '', codec: ext.slice(1), text: true });
    }
  };
  look(dir, true);
  for (const sub of ['Subs', 'subs', 'Subtitles', 'subtitles']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    look(d, videosInFolder > 1);
    look(path.join(d, path.basename(videoPath, path.extname(videoPath))), false); // Subs/<video name>/English.srt
  }
  return out;
}

const NAMES = { eng: 'English', jpn: 'Japanese', spa: 'Spanish', fra: 'French', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian', zho: 'Chinese', kor: 'Korean', ara: 'Arabic', nld: 'Dutch' };
const langName = (l) => NAMES[l] || (l ? l.toUpperCase() : '');
// "Japanese", "English (Dub)", "English · commentary"…
function audioLabel(a, all) {
  const name = langName(a.lang) || a.title || `Audio ${a.n + 1}`;
  const extra = a.title && a.title.toLowerCase() !== name.toLowerCase() ? a.title : '';
  const dupe = all.filter((x) => x.lang === a.lang).length > 1 && !extra;
  return name + (extra ? ` (${extra})` : dupe ? ` ${a.n + 1}` : '');
}
const signsOnly = (t) => /\b(signs?|songs?|forced|karaoke|op\s*\/?\s*ed)\b/i.test(t.title || '') || t.forced;

// Everything a video offers, with friendly labels, plus what "Auto" would pick.
async function subtitlesFor(item, { lang = 'eng', mode = 'auto', videosInFolder = 1 } = {}) {
  if (!item || item.remote || !item.path) return { tracks: [], audio: [], pick: null, intro: null, outro: null };
  const { audio, subs, chapters } = await probeTracks(item.path);
  const tracks = [];
  subs.forEach((s) => tracks.push({ id: 'e' + s.n, n: s.n, lang: s.lang, title: s.title, forced: s.forced, default: s.default, kind: s.image ? 'image' : s.text ? 'text' : 'other', codec: s.codec }));
  externalSubs(item.path, videosInFolder).forEach((x, i) => tracks.push({ id: 'x' + i, file: x.file, lang: x.lang, title: x.title, forced: x.forced, sdh: x.sdh, kind: 'text', codec: x.codec }));
  const usable = tracks.filter((t) => t.kind !== 'other');
  // Friendly names: "English", "English (Signs & Songs)", "English · picture", "Japanese (file)".
  for (const t of usable) {
    const name = langName(t.lang) || t.title || `Subtitles ${usable.indexOf(t) + 1}`;
    const extra = t.title && t.title.toLowerCase() !== name.toLowerCase() ? t.title : t.forced ? 'forced' : t.sdh ? 'SDH' : '';
    t.label = name + (extra ? ` (${extra})` : '') + (t.kind === 'image' ? ' · picture' : '') + (t.file ? ' · file' : '');
  }
  // Auto: on when the audio isn't in your language (or the file says so), off when it is.
  // The first track is what plays unless you pick another (files' "default" flags vary).
  const mainAudio = audio[0];
  const audioLang = mainAudio?.lang || '';
  const best = (list) => list.filter((t) => !signsOnly(t)).sort((a, b) => (a.kind === 'text' ? 0 : 1) - (b.kind === 'text' ? 0 : 1) || (b.default ? 1 : 0) - (a.default ? 1 : 0))[0] || list[0];
  const mine = usable.filter((t) => t.lang === lang);
  let pick = null;
  if (mode === 'on') pick = best(mine) || best(usable);
  else if (mode === 'auto') {
    if (audioLang && audioLang !== lang) pick = best(mine) || null;
    else if (!audioLang) pick = best(mine.length ? mine : usable.filter((t) => t.default)) || null; // unlabeled audio: follow the file's own default
    else pick = mine.find((t) => signsOnly(t)) || null; // your language: just signs/forced if there are any
  }
  return { tracks: usable.map(({ id, label, lang: l, kind }) => ({ id, label, lang: l, kind })), audio: audio.map((a) => ({ n: a.n, lang: a.lang, title: a.title, default: a.default, label: audioLabel(a, audio) })), audioLang, pick: pick?.id || null, _all: usable, ...introOutro(chapters) };
}

// Chapters named like an opening / ending (common in anime releases): what "Skip intro"
// and "Next episode" use when the file has them.
function introOutro(chapters = []) {
  const len = (c) => c.end - c.start;
  const t = (c) => c.title.trim();
  // 1) a chapter named Opening / OP; 2) an unnamed ~1:30 chapter in the first 6 minutes
  // (the opening song after a cold open); an "Intro" counts only if it's song-length.
  const op = chapters.find((c) => /^(op|opening)\b/i.test(t(c)) && len(c) > 20 && len(c) < 240 && c.start < 600)
    || chapters.find((c) => (!t(c) || /^(intro|\(unnamed\)|chapter\s*\d+|\d+)$/i.test(t(c))) && len(c) >= 75 && len(c) <= 105 && c.start < 360);
  const ed = chapters.find((c) => /^(ed|ending|end credits|credits)\b/i.test(t(c)) && len(c) > 20);
  return { intro: op ? { start: op.start, end: op.end } : null, outro: ed ? { start: ed.start } : null };
}


// A text track as WebVTT, starting at `t` seconds (to line up with a stream that starts there).
function vttArgs(item, track, t) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (t > 0) a.push('-ss', String(t));
  if (track.file) a.push('-i', track.file);
  else a.push('-i', item.path, '-map', `0:s:${track.n}`);
  a.push('-f', 'webvtt', 'pipe:1');
  return a;
}

module.exports = { subtitlesFor, probeTracks, externalSubs, vttArgs, lang3 };
