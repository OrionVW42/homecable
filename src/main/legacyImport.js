// Imports the schedule file from the old Kivy "VideoApp" (a Python dict literal
// written with str(): {'Monday': {0.0: {'videos': [...], 'randomize': bool, 'seq': n}, ...}}).
// Parsed with a small literal reader — never eval'd.
const path = require('path');

function parsePyLiteral(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const fail = (m) => { throw new Error(`${m} at ${i}`); };
  function value() {
    ws();
    const c = src[i];
    if (c === '{') {
      i++; const obj = new Map(); ws();
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        const k = value(); ws();
        if (src[i++] !== ':') fail('expected :');
        obj.set(k, value()); ws();
        if (src[i] === ',') { i++; ws(); if (src[i] === '}') { i++; return obj; } continue; }
        if (src[i++] === '}') return obj;
        fail('expected , or }');
      }
    }
    if (c === '[' || c === '(') {
      const close = c === '[' ? ']' : ')';
      i++; const arr = []; ws();
      if (src[i] === close) { i++; return arr; }
      for (;;) {
        arr.push(value()); ws();
        if (src[i] === ',') { i++; ws(); if (src[i] === close) { i++; return arr; } continue; }
        if (src[i++] === close) return arr;
        fail('expected , or ' + close);
      }
    }
    if (c === "'" || c === '"') {
      const q = c; i++; let s = '';
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          const n = src[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'x' ? String.fromCharCode(parseInt(src.substr(i + 2, 2), 16)) : n;
          i += n === 'x' ? 4 : 2;
        } else s += src[i++];
      }
      i++;
      return s;
    }
    const m = src.slice(i).match(/^(True|False|None|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/);
    if (!m) fail('unexpected token');
    i += m[0].length;
    return m[0] === 'True' ? true : m[0] === 'False' ? false : m[0] === 'None' ? null : Number(m[0]);
  }
  const v = value();
  return v;
}

const DAY_NUM = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const hm = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${h % 1 ? '30' : '00'}`;

// Returns { blocks, folders } where blocks follow the scheduler's block shape.
function importLegacySchedule(text) {
  const data = parsePyLiteral(text.trim());
  if (!(data instanceof Map)) throw new Error('Not a schedule file');
  const runs = []; // {day, start, end, folder, random, seq}
  for (const [day, slots] of data) {
    if (!(day in DAY_NUM) || !(slots instanceof Map)) continue;
    const times = [...slots.keys()].sort((a, b) => a - b);
    let run = null;
    for (const t of times) {
      const s = slots.get(t);
      const folder = s instanceof Map ? (s.get('videos') || [])[0] : null;
      const random = s instanceof Map && !!s.get('randomize');
      if (run && folder && run.folder === folder && run.random === random && run.end === t) { run.end = t + 0.5; continue; }
      if (run) runs.push(run);
      run = folder ? { day: DAY_NUM[day], start: t, end: t + 0.5, folder, random, seq: s.get('seq') || 0 } : null;
    }
    if (run) runs.push(run);
  }
  // Same folder at the same time on several days → one block with several days.
  const merged = new Map();
  for (const r of runs) {
    const k = `${r.folder}|${r.start}|${r.end}|${r.random}`;
    if (merged.has(k)) merged.get(k).days.push(r.day);
    else merged.set(k, { ...r, days: [r.day] });
  }
  const blocks = [...merged.values()].map((r, n) => {
    const parts = r.folder.split(/[\\/]/).filter(Boolean);
    // "D:\Video\TV\Buffy\1 Monday" → "Buffy"
    const name = /^\d?\s*\w+day$/i.test(parts[parts.length - 1]) ? parts[parts.length - 2] : parts[parts.length - 1];
    return {
      id: 'imp' + n, name: name || r.folder, days: r.days.sort(), start: hm(r.start), end: hm(r.end),
      order: r.random ? 'shuffle' : 'ordered', startAt: r.random ? 0 : r.seq,
      sources: [{ type: 'folder', path: r.folder, label: name }],
    };
  });
  // Library roots to scan: the folder above each show folder, deduped.
  const roots = new Set();
  for (const b of blocks) {
    const f = b.sources[0].path;
    const parts = f.split(/[\\/]/);
    roots.add(parts.slice(0, Math.max(2, parts.length - 2)).join(path.sep));
  }
  return { blocks, folders: [...roots] };
}

module.exports = { parsePyLiteral, importLegacySchedule };
