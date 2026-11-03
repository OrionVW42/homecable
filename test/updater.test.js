'use strict';
// The update engine (src/boot/core.js) against a fake GitHub on localhost.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-upd-'));
process.env.HOMECABLE_VERSIONS_DIR = path.join(tmp, 'versions');
const SHELL = 'shell-aaaa';

const appBody = Buffer.from('fake app file '.repeat(5000));
const sha = crypto.createHash('sha256').update(appBody).digest('hex');
let release, manifest, served = {};
const srv = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  if (req.url === '/repos/o/r/releases/latest') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(release(base)));
  }
  if (req.url === '/dl/homecable-update.json') return res.end(JSON.stringify(manifest));
  if (served[req.url]) return res.end(served[req.url]);
  res.statusCode = 404; res.end();
});

let core;
test.before(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.HOMECABLE_UPDATE_API = `http://127.0.0.1:${srv.address().port}`;
  core = require('../src/boot/core');
});
test.after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const rel = (v, { withApp = true } = {}) => (base) => ({
  tag_name: 'v' + v, body: 'Better updates',
  assets: [
    { name: `HomeCable-Setup-${v}.exe`, size: 4, browser_download_url: `${base}/dl/setup.exe` },
    ...(withApp ? [{ name: 'homecable-update.json', size: 10, browser_download_url: `${base}/dl/homecable-update.json` },
      { name: `homecable-app-${v}.asar`, size: appBody.length, browser_download_url: `${base}/dl/app.asar` }] : []),
  ],
});

test('versions compare', () => {
  assert.ok(core.newer('1.4.10', '1.4.9'));
  assert.ok(!core.newer('1.4.8', '1.4.8'));
  assert.ok(core.newer('v2.0.0', '1.9.9'));
});

test('nothing newer → null', async () => {
  release = rel('1.4.8'); manifest = { version: '1.4.8', shell: SHELL, app: { name: 'homecable-app-1.4.8.asar', size: appBody.length, sha256: sha } };
  assert.strictEqual(await core.latest({ repo: 'o/r', current: '1.4.8' }), null);
});

test('same shell → app-file update; other shell → installer; no manifest → installer', async () => {
  release = rel('1.4.9'); manifest = { version: '1.4.9', shell: SHELL, app: { name: 'homecable-app-1.4.9.asar', size: appBody.length, sha256: sha } };
  const info = await core.latest({ repo: 'o/r', current: '1.4.8' });
  assert.strictEqual(info.version, '1.4.9');
  assert.strictEqual(core.plan(info, SHELL).kind, 'app');
  assert.strictEqual(core.plan(info, 'other-shell').kind, 'installer');
  assert.strictEqual(core.plan(info, null).kind, 'installer'); // dev: never swaps
  release = rel('1.4.9', { withApp: false });
  assert.strictEqual(core.plan(await core.latest({ repo: 'o/r', current: '1.4.8' }), SHELL).kind, 'installer');
});

test('a damaged download never counts', async () => {
  release = rel('1.4.9'); manifest = { version: '1.4.9', shell: SHELL, app: { name: 'homecable-app-1.4.9.asar', size: appBody.length, sha256: sha } };
  served['/dl/app.asar'] = Buffer.from(appBody).fill(65, 0, 10); // same size, wrong bytes
  const info = await core.latest({ repo: 'o/r', current: '1.4.8' });
  await assert.rejects(core.fetchApp(info, { current: '1.4.8' }), /checksum/);
  assert.deepStrictEqual(core.installed(SHELL), []);
  served['/dl/app.asar'] = appBody.subarray(0, 100); // short
  await assert.rejects(core.fetchApp(info, { current: '1.4.8' }), /incomplete/);
  assert.deepStrictEqual(core.installed(SHELL), []);
});

test('download, pick, trial, rollback', async () => {
  served['/dl/app.asar'] = appBody;
  const info = await core.latest({ repo: 'o/r', current: '1.4.8' });
  const seen = [];
  await core.fetchApp(info, { current: '1.4.8', onProgress: (g, t) => seen.push([g, t]) });
  assert.ok(seen.length && seen.at(-1)[0] === appBody.length);
  const builtin = { version: '1.4.8', dir: 'B', builtin: true };
  assert.strictEqual(core.pick({ builtin, shell: SHELL }).version, '1.4.9');
  assert.strictEqual(core.pick({ builtin, shell: 'other' }).version, '1.4.8', 'other shell never runs it');
  // Two starts that never open the window → marked bad, back to the builtin.
  core.beginTrial('1.4.9'); assert.strictEqual(core.pick({ builtin, shell: SHELL }).version, '1.4.9');
  core.beginTrial('1.4.9'); assert.strictEqual(core.pick({ builtin, shell: SHELL }).version, '1.4.8');
  assert.ok(core.readState().bad.includes('1.4.9'));
  // A fresh download of it gets a fresh chance; a good start sticks.
  await core.fetchApp(info, { current: '1.4.8' });
  assert.strictEqual(core.pick({ builtin, shell: SHELL }).version, '1.4.9');
  core.beginTrial('1.4.9'); core.markGood('1.4.9');
  core.beginTrial('1.4.9'); core.beginTrial('1.4.9');
  assert.strictEqual(core.pick({ builtin, shell: SHELL }).version, '1.4.9', 'a good version is never on trial again');
  // A newer installer outranks nothing on its own; a newer built-in wins over downloads.
  assert.strictEqual(core.pick({ builtin: { version: '1.5.0', dir: 'B2', builtin: true }, shell: SHELL }).version, '1.5.0');
});

test('tidy keeps current + newest two, drops other shells', async () => {
  const root = process.env.HOMECABLE_VERSIONS_DIR;
  for (const [v, sh] of [['1.4.5', SHELL], ['1.4.6', SHELL], ['1.4.7', 'old-shell']]) {
    fs.mkdirSync(path.join(root, v), { recursive: true });
    fs.writeFileSync(path.join(root, v, 'app.asar'), 'x');
    fs.writeFileSync(path.join(root, v, 'meta.json'), JSON.stringify({ version: v, shell: sh, size: 1 }));
  }
  core.tidy({ keep: ['1.4.9'], shell: SHELL });
  assert.deepStrictEqual(fs.readdirSync(root).filter((n) => /^\d/.test(n)).sort(), ['1.4.6', '1.4.9']);
});

test('installer download + pending', async () => {
  served['/dl/setup.exe'] = Buffer.from('exe!');
  release = rel('1.5.0', { withApp: false });
  const info = await core.latest({ repo: 'o/r', current: '1.4.9' });
  const p = await core.fetchInstaller(info, { current: '1.4.9' });
  assert.strictEqual(core.pendingInstaller('1.4.9').version, '1.5.0');
  assert.strictEqual(core.pendingInstaller('1.5.0'), null, 'already on it → dropped');
  assert.ok(!fs.existsSync(p.file));
});

test('only GitHub hosts outside tests', () => {
  const saved = process.env.HOMECABLE_UPDATE_API; delete process.env.HOMECABLE_UPDATE_API;
  try {
    assert.ok(core.okHost('https://objects.githubusercontent.com/x'));
    assert.ok(core.okHost('https://github.com/OrionVW42/homecable/releases/download/v1/a'));
    assert.ok(!core.okHost('https://evil.example/x'));
    assert.ok(!core.okHost('https://github.com.evil.example/x'));
  } finally { process.env.HOMECABLE_UPDATE_API = saved; }
});

// 1.4.11 (2026-11-02): cleaning up an old version emptied the INSTALLED ffmpeg folder
// through the link 1.4.10 put in each version folder — nothing could play.
test('cleaning up old versions never touches the installed program (links are only unlinked)', () => {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tidy-'));
  const target = path.join(W, 'install', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'ffmpeg.exe'), 'pretend ffmpeg');
  const ver = path.join(W, 'versions');
  const old = process.env.HOMECABLE_VERSIONS_DIR;
  process.env.HOMECABLE_VERSIONS_DIR = ver;
  try {
    for (const v of ['1.4.9', '1.4.10', '1.4.11']) {
      const d = path.join(ver, v);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'app.asar'), 'x');
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ version: v, shell: 'S', size: 1 }));
      fs.symlinkSync(path.join(W, 'install', 'app.asar.unpacked'), path.join(d, 'app.asar.unpacked'), 'junction');
    }
    core.tidy({ keep: ['1.4.11'], shell: 'S' });
    assert.ok(fs.existsSync(path.join(target, 'ffmpeg.exe')), 'the installed ffmpeg is still there');
    assert.deepStrictEqual(fs.readdirSync(ver).sort(), ['1.4.10', '1.4.11'], 'only the oldest version was removed');
    // the kept versions lose their old links too, and nothing new is linked
    for (const v of ['1.4.10', '1.4.11']) assert.ok(!fs.existsSync(path.join(ver, v, 'app.asar.unpacked')), `${v} has no link any more`);
    assert.ok(fs.existsSync(path.join(target, 'ffmpeg.exe')), 'still there after the links went');
    // a REAL folder in that spot (not a link) is never emptied
    const real = path.join(ver, '1.4.10', 'app.asar.unpacked');
    fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'keep.txt'), 'k');
    core.dropLink(real);
    assert.ok(fs.existsSync(path.join(real, 'keep.txt')));
  } finally {
    if (old == null) delete process.env.HOMECABLE_VERSIONS_DIR; else process.env.HOMECABLE_VERSIONS_DIR = old;
    fs.rmSync(W, { recursive: true, force: true });
  }
});
