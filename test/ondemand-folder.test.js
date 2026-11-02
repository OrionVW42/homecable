// The On Demand folder: read only when asked (opening the On Demand screen), never
// watched or swept up by a parent folder's scans; picks up added and deleted movies,
// whole deleted folders, and waits for a movie that is still being copied in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.HOMECABLE_SETTLE_MS = '400';
const { Library } = require('../src/main/library');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-odf-'));
const videos = path.join(root, 'Videos');          // a normal library folder…
const od = path.join(videos, 'On Demand');          // …with the On Demand folder inside it
const clip = path.join(root, 'clip.mp4');
execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=10:d=200', '-f', 'lavfi', '-i', 'anoisesrc=d=200:a=0.3', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-c:a', 'aac', '-shortest', clip]);
const put = (rel) => { const f = path.join(od, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(clip, f); return f; };
const store = { data: {}, read(k, d) { return this.data[k] || d; }, write(k, v) { this.data[k] = v; } };
const titles = (lib) => lib.list().filter((i) => i.path.startsWith(od)).map((i) => i.title).sort();

test('on-demand folder: only read when asked, adds and removes, folders and still-copying files', async () => {
  fs.mkdirSync(videos, { recursive: true });
  put('Alpha (2001)/Alpha (2001).mp4');
  const lib = new Library(store);
  lib.setQuietFolders([od]);

  // The parent library folder's scans never touch the On Demand folder.
  await lib.scan([videos], { prune: true });
  assert.deepStrictEqual(titles(lib), []);
  assert.ok(![...lib.watchers.keys()].some((f) => f.toLowerCase().startsWith(od.toLowerCase())), 'On Demand folder is not watched');

  // Opening the On Demand screen reads it.
  await lib.scan([od], { prune: true, policy: 'auto' });
  assert.deepStrictEqual(titles(lib), ['Alpha']);
  assert.ok(!lib.watchers.has(od), 'still not watched after reading it');

  // Added since: picked up next time. Then a parent scan leaves the On Demand movies alone.
  put('Beta (2002).mp4');
  await lib.scan([od], { prune: true, policy: 'auto' });
  assert.deepStrictEqual(titles(lib), ['Alpha', 'Beta']);
  await lib.scan([videos], { prune: true });
  assert.deepStrictEqual(titles(lib), ['Alpha', 'Beta'], "a parent folder's scan doesn't remove them");

  // A deleted file, and a deleted movie folder, both disappear.
  fs.rmSync(path.join(od, 'Beta (2002).mp4'));
  fs.rmSync(path.join(od, 'Alpha (2001)'), { recursive: true });
  put('Gamma (2003)/Gamma (2003).mp4');
  await lib.scan([od], { prune: true, policy: 'auto' });
  assert.deepStrictEqual(titles(lib), ['Gamma']);

  // A movie still being copied in (size growing) waits; once finished, it's added.
  const big = path.join(od, 'Delta (2004).mp4');
  const data = fs.readFileSync(clip);
  fs.writeFileSync(big, data.subarray(0, Math.floor(data.length / 2)));
  let grow = setInterval(() => { try { fs.appendFileSync(big, Buffer.alloc(64 * 1024)); } catch {} }, 50);
  await lib.scan([od], { prune: true, policy: 'auto' });
  clearInterval(grow);
  assert.deepStrictEqual(titles(lib), ['Gamma'], 'not added half-copied');
  fs.writeFileSync(big, data);
  await lib.scan([od], { prune: true, policy: 'auto' });
  assert.deepStrictEqual(titles(lib), ['Delta', 'Gamma']);
  const delta = lib.list().find((i) => i.title === 'Delta');
  assert.ok(Math.abs(delta.duration - 200) < 2, 'read once complete: full length ' + delta.duration);
  for (const w of lib.watchers.values()) w.close();
  for (const t of (lib._soon || new Map()).values()) clearTimeout(t);
});
