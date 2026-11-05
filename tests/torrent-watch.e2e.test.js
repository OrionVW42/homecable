// "Watch without keeping": a torrent fetches only what you're watching and the next episode,
// clears a video once it's finished or you've moved on, keeps resume points and history, and
// stays under its cache limit. Real app, off-screen, temp data. No internet: three generated
// clips, shared by a real peer running on this PC.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

test.describe.configure({ mode: 'serial' });
// Internet traffic: on a machine with a VPN, only through it. Elsewhere set HOMECABLE_ALLOW_NO_VPN=1.
test.skip(!require('../src/main/vpn').detectNow('auto') && !process.env.HOMECABLE_ALLOW_NO_VPN, 'torrent tests run only with a VPN up');

// A proper MP4 'free' box: padding a video reader skips over, as with any big real file.
const freeBox = (size, fill) => { const b = Buffer.alloc(size, fill); b.writeUInt32BE(size, 0); b.write('free', 4, 'latin1'); return b; };

const NAME = 'Test Show S01';
const EPS = ['Test.Show.S01E01.mp4', 'Test.Show.S01E02.mp4', 'Test.Show.S01E03.mp4'];
let app, page, data, root, seeder, torrentFile, serverId;
const items = () => page.evaluate(() => window.tv.browse().then((b) => b.items));
const ep = async (n) => (await items()).find((i) => i.torrent !== null && i.episode === n && /test show/i.test(i.show || ''));
const list = () => page.evaluate(() => window.tv.torrentsList());
const fileOf = async (n) => (await list()).find((t) => t.id === serverId)?.files.find((f) => f.path.includes(`E0${n}`));
const onDisk = (n) => fs.existsSync(path.join(data, 'torrents', serverId.replace('torrent:', '').slice(0, 16), NAME, EPS[n - 1]));

test.beforeAll(async () => {
  test.setTimeout(180000);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-watch-src-'));
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-watch-'));
  const dir = path.join(root, NAME);
  fs.mkdirSync(dir);
  const ffmpeg = require('ffmpeg-static');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=5', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '200', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '150k', '-c:a', 'aac', '-b:a', '32k', '-shortest', '-movflags', '+faststart', path.join(root, 'clip.mp4')]);
  // Big enough that a metadata read on this very fast local peer cannot fetch a whole file.
  EPS.forEach((n, i) => { fs.writeFileSync(path.join(dir, n), Buffer.concat([fs.readFileSync(path.join(root, 'clip.mp4')), freeBox(100e6 + i, i + 1)])); });
  // A real peer on this PC, with the three clips.
  const { default: WebTorrent } = await import('webtorrent');
  seeder = new WebTorrent({ natUpnp: false, natPmp: false, utp: false, lsd: false, dht: false, tracker: false });
  const seeded = await new Promise((ok) => seeder.seed(dir, { name: NAME, announceList: [] }, ok));
  await new Promise((r) => setTimeout(r, 1000));
  torrentFile = `magnet:?xt=urn:btih:${seeded.infoHash}&dn=${encodeURIComponent(NAME)}&x.pe=127.0.0.1:${seeder.torrentPort}`;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ torrentsOn: true, updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, torrentVpn: 'off', torrentVpnWarn: false, seedDefault173: true, privacyClean173: true }));
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }),
    env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.tv);
});
test.afterAll(async () => { await app?.close(); await new Promise((r) => (seeder ? seeder.destroy(r) : r())); });

test('on by default: a new torrent fetches nothing but its index until you watch', async () => {
  test.setTimeout(180000);
  const s = (await page.evaluate(() => window.tv.state())).settings;
  expect(s.torrentWatchOnly).toBe(true);
  expect(s.torrentCacheGB).toBe(50);
  const r = await page.evaluate((f) => window.tv.torrentAdd(f), torrentFile);
  serverId = r.serverId;
  expect(r.added).toBe(3);
  expect((await list()).find((t) => t.id === serverId).watchOnly).toBe(true);
  await page.waitForTimeout(4000);
  for (const n of [1, 2, 3]) expect((await fileOf(n)).progress, `episode ${n} isn't downloaded`).toBeLessThan(0.6);
});

test('watching fetches that episode and the next, not the rest', async () => {
  test.setTimeout(420000);
  const one = await ep(1);
  await page.evaluate((id) => window.tv.vod(id, 0), one.id);
  await expect.poll(async () => (await fileOf(1)).progress, { timeout: 200000 }).toBeGreaterThan(0.99);
  await expect.poll(async () => (await fileOf(2)).progress, { timeout: 200000 }).toBeGreaterThan(0.99);
  expect((await fileOf(3)).progress, 'episode 3 waits').toBeLessThan(0.6);
});

test('a half-watched episode stays, with its place', async () => {
  const one = await ep(1);
  await page.evaluate((id) => window.tv.saveProgress({ id, pos: 60, len: 200 }), one.id);
  await page.waitForTimeout(1500);
  expect((await items()).some((i) => i.id === one.id), 'still in the library').toBe(true);
  expect(onDisk(1), 'still cached').toBe(true);
  expect((await page.evaluate(() => window.tv.state())).settings.vodResume[one.id]).toBe(60);
});

test('moving on to the next episode clears the one before it', async () => {
  test.setTimeout(90000);
  const one = await ep(1), two = await ep(2);
  await page.evaluate((id) => window.tv.vod(id, 0), two.id);
  await expect.poll(async () => (await items()).some((i) => i.id === one.id), { timeout: 40000 }).toBe(false);
  await expect.poll(() => onDisk(1), { timeout: 15000, message: 'its file is deleted' }).toBe(false);
  expect(onDisk(2), 'the one playing stays').toBe(true);
  // ...and the next one starts arriving.
  await expect.poll(async () => (await fileOf(3)).progress, { timeout: 60000 }).toBeGreaterThan(0.1);
});

test('finishing clears it, and the history stays', async () => {
  test.setTimeout(60000);
  const two = await ep(2);
  await page.evaluate((id) => window.tv.saveProgress({ id, pos: 195, len: 200 }), two.id);
  await expect.poll(async () => (await items()).some((i) => i.id === two.id), { timeout: 40000 }).toBe(false);
  await expect.poll(() => onDisk(2), { timeout: 15000 }).toBe(false);
  expect((await page.evaluate(() => window.tv.state())).settings.vodWatched[two.id], 'still marked watched').toBeTruthy();
});

test('📌 Keep is never cleared; over the cache limit, the rest is', async () => {
  test.setTimeout(60000);
  const three = await ep(3);
  await page.evaluate((id) => window.tv.torrentKeep(id, true), three.id);
  await page.evaluate(() => window.tv.setSettings({ torrentCacheGB: 0.001 })); // 1 MB
  await page.waitForTimeout(3000);
  expect((await items()).some((i) => i.id === three.id), 'kept').toBe(true);
  await page.evaluate((id) => window.tv.torrentKeep(id, false), three.id);
  await page.evaluate(() => window.tv.setSettings({ torrentCacheGB: 0.002 }));
  await expect.poll(async () => (await items()).some((i) => i.id === three.id), { timeout: 40000 }).toBe(false);
  await expect.poll(async () => (await list()).some((t) => t.id === serverId), { timeout: 20000, message: 'nothing left: the torrent goes too' }).toBe(false);
  await page.evaluate(() => window.tv.setSettings({ torrentCacheGB: 50 }));
});

test('turned off: a torrent downloads everything and keeps it, as before', async () => {
  test.setTimeout(560000);
  await page.evaluate(() => window.tv.setSettings({ torrentWatchOnly: false }));
  const r = await page.evaluate((f) => window.tv.torrentAdd(f), torrentFile);
  serverId = r.serverId;
  expect((await list()).find((t) => t.id === serverId).watchOnly).toBe(false);
  for (const n of [1, 2, 3]) await expect.poll(async () => (await fileOf(n)).progress, { timeout: 170000 }).toBeGreaterThan(0.99);
  const one = await ep(1);
  await page.evaluate((id) => window.tv.saveProgress({ id, finished: true, pos: 200, len: 200 }), one.id);
  await page.waitForTimeout(2500);
  expect((await items()).some((i) => i.id === one.id), 'kept after watching').toBe(true);
});
