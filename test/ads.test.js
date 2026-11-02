const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { makePack, syncFeed, MANIFEST } = require('../src/main/ads');
const { ffmpegPath } = require('../src/main/ffmpeg');

const mk = (file, secs) => execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=160x90:r=10:d=${secs}`, '-c:v', 'libx264', '-preset', 'ultrafast', file]);
const fakeLib = () => Object.assign(new EventEmitter(), { items: {}, save() {}, list() { return Object.values(this.items); } });

test('ad packs: build, publish, sync, update and remove', async () => {
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pack-'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cache-'));
  mk(path.join(pack, 'Dial-A-Llama (2).mp4'), 6);
  mk(path.join(pack, 'Static B Gone.mp4'), 8);
  mk(path.join(pack, 'Too Long.mp4'), 50);

  const r = await makePack(pack);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /trim/);
  const m = JSON.parse(fs.readFileSync(path.join(pack, MANIFEST), 'utf8'));
  assert.deepStrictEqual(m.ads.map((a) => a.title).sort(), ['Dial-A-Llama', 'Static B Gone']);

  // A static host (stand-in for Cloudflare/GitHub Pages).
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, cookie: req.headers.cookie, referer: req.headers.referer, ua: req.headers['user-agent'] });
    const f = path.join(pack, decodeURIComponent(req.url.slice(1)));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(f).pipe(res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/${MANIFEST}`;
  try {
    const lib = fakeLib();
    const s1 = await syncFeed(lib, url, cache);
    assert.strictEqual(s1.added, 2);
    assert.strictEqual(lib.list().filter((i) => i.kind === 'ad').length, 2);
    assert.ok(lib.list().every((i) => fs.existsSync(i.path)), 'ads are cached locally');
    // Nothing identifying is sent.
    assert.ok(hits.every((h) => !h.cookie && !h.referer && h.ua === 'HomeCable'));

    // Second sync: nothing new to download (only the list is fetched).
    hits.length = 0;
    const s2 = await syncFeed(lib, url, cache);
    assert.strictEqual(s2.added, 0);
    assert.strictEqual(hits.length, 1);

    // The creator removes an ad and republishes: it disappears from players.
    fs.rmSync(path.join(pack, 'Static B Gone.mp4'));
    await makePack(pack);
    const s3 = await syncFeed(lib, url, cache);
    assert.strictEqual(s3.removed, 1);
    assert.deepStrictEqual(lib.list().map((i) => i.title), ['Dial-A-Llama']);
    assert.strictEqual(fs.readdirSync(cache).length, 1);

    // A tampered file (checksum mismatch) is refused.
    const man = JSON.parse(fs.readFileSync(path.join(pack, MANIFEST), 'utf8'));
    man.ads[0].sha256 = 'f'.repeat(64);
    fs.writeFileSync(path.join(pack, MANIFEST), JSON.stringify(man));
    const s4 = await syncFeed(fakeLib(), url, fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cache2-')));
    assert.strictEqual(s4.added, 0);

    // Plain http to the internet is refused (https only).
    await assert.rejects(() => syncFeed(fakeLib(), 'http://example.com/ads.json', cache), /https/);
  } finally {
    server.close();
  }
});
