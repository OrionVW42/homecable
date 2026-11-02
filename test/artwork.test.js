const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { findPoster, needsPoster, sidecarFor } = require('../src/main/artwork');
const { Scheduler } = require('../src/main/scheduler');

const run = (...a) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-art-'));
const red = path.join(tmp, 'red.png'), blue = path.join(tmp, 'blue.png');
run('-f', 'lavfi', '-i', 'color=c=red:s=300x450', '-frames:v', '1', red);
run('-f', 'lavfi', '-i', 'color=c=blue:s=300x450', '-frames:v', '1', blue);
const clip = (out, extra = []) => { fs.mkdirSync(path.dirname(out), { recursive: true }); run('-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2', ...extra, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out); };
// Average colour of a poster: is it the red or the blue picture?
const tint = (jpg) => { const raw = execFileSync(ffmpeg, ['-loglevel', 'error', '-i', jpg, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return raw[0] > raw[2] ? 'red' : 'blue'; };

test('cover art inside an MP4 wins over a picture beside it', async () => {
  const f = path.join(tmp, 'A', 'Alpha (1999).mp4');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const bare = path.join(tmp, 'bare.mp4');
  clip(bare);
  run('-i', bare, '-i', red, '-map', '0', '-map', '1', '-c', 'copy', '-disposition:v:1', 'attached_pic', f);
  fs.copyFileSync(blue, path.join(tmp, 'A', 'Alpha (1999).png'));
  const it = { id: 'a', kind: 'movie', title: 'Alpha', year: 1999, path: f };
  assert.strictEqual(await findPoster(it, { dir: path.join(tmp, 'cache'), online: false }), true);
  assert.strictEqual(it.posterFrom, 'file');
  assert.strictEqual(tint(it.poster), 'red');
});

test('a picture named like the movie is used when the file has no cover', async () => {
  const f = path.join(tmp, 'Shared', 'Beta.mp4');
  clip(f);
  fs.copyFileSync(blue, path.join(tmp, 'Shared', 'beta-poster.PNG'));
  const it = { id: 'b', kind: 'movie', title: 'Beta', path: f };
  assert.strictEqual(await findPoster(it, { dir: path.join(tmp, 'cache'), online: false, siblings: 5 }), true);
  assert.strictEqual(it.posterFrom, 'folder');
  assert.strictEqual(tint(it.poster), 'blue');
});

test('poster.jpg / folder.jpg only count when the movie has its own folder', () => {
  const dir = path.join(tmp, 'Gamma (2001)');
  clip(path.join(dir, 'Gamma.mp4'));
  fs.copyFileSync(red, path.join(dir, 'folder.png'));
  const it = { id: 'g', kind: 'movie', title: 'Gamma', path: path.join(dir, 'Gamma.mp4') };
  assert.ok(sidecarFor(it, 1)?.endsWith('folder.png'));
  assert.strictEqual(sidecarFor(it, 3), null); // a shared folder's art belongs to no single movie
});

test('no art anywhere and offline: nothing found, and it is not retried until the file changes', async () => {
  const f = path.join(tmp, 'Many', 'Delta.mp4');
  clip(f);
  const it = { id: 'd', kind: 'movie', title: 'Delta', path: f, mtime: Date.now() - 1000 };
  assert.strictEqual(await findPoster(it, { dir: path.join(tmp, 'cache'), online: false, siblings: 4 }), false);
  assert.strictEqual(needsPoster(it, false), false);
  it.mtime = Date.now() + 1000; // the file was replaced
  assert.strictEqual(needsPoster(it, false), true);
  assert.strictEqual(needsPoster({ ...it, kind: 'episode' }, true), false); // posters are for movies
});

test('on-demand channels get no schedule', () => {
  const lib = { items: { m: { id: 'm', kind: 'movie', duration: 5400 } }, list() { return Object.values(this.items); }, resolve() { return Object.values(this.items); }, shows: () => [] };
  const store = { read: () => ({}), write() {} };
  const s = new Scheduler(store, lib);
  const od = { id: 'od', ondemand: true, sources: [{ type: 'kind', kind: 'movie' }], filler: [], blocks: [], order: 'shuffle', align: 30 };
  s.ensure([od]); s.rebuild(od); s.libraryChanged([od]);
  assert.strictEqual(s.stateOf(od).programs.length, 0);
});
