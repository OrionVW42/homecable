// Adults only: off and refused until a grown-up turns it on with their date of birth; stations
// are links you add, kept out of everything else. Temp data, off-screen, silent. The "stations"
// are a plain test pattern served from this PC (127.0.0.1 only); nothing is fetched from the internet.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-adult-'));
const vids = path.join(data, 'videos');
fs.mkdirSync(vids);
const clipDir = data + '-clip';
fs.mkdirSync(clipDir, { recursive: true });
const clip = path.join(clipDir, 'pattern.mp4');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=120', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', clip]);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ updateOnStart: false, updateEvery: 'off', setupDone: true, tourDone: true, adsOn: false, seedDefault173: true, privacyClean173: true, torrentLock176: true }));

let server, base, app, page;
const call = (fn, ...a) => page.evaluate(([f, args]) => window.tv[f](...args).then((r) => ({ r }), (e) => ({ e: e.message })), [fn, a]);
const settingsFile = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
const nav = () => page.locator('.topbar .adult-nav');

test.beforeAll(async () => {
  const body = fs.readFileSync(clip);
  server = http.createServer((req, res) => {
    if (req.url === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end(`#EXTM3U\n#EXTINF:-1 group-title="Test",Test Station\n${base}/a.mp4\n#EXTINF:-1,Gone Station\n${base}/missing.mp4\n`); }
    if (req.url === '/a.mp4' || req.url === '/b.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length }); return res.end(body); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_VIDEOS: vids, HOMECABLE_MUTE: '1', HOMECABLE_NO_INSTALL: '1', HOMECABLE_OFFSCREEN: '1', HOMECABLE_NO_CAST: '1' } });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.tv);
  await page.waitForSelector('.topbar');
});
test.afterAll(async () => {
  await app?.close().catch(() => {});
  server?.close();
  for (const d of [data, clipDir]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
});

test('off to begin with: no button, and the app refuses it', async () => {
  await expect(nav()).toHaveCount(0);
  expect((await call('adultList')).e).toMatch(/turned off/);
  expect((await call('adultAdd', base + '/list.m3u')).e).toMatch(/turned off/);
  expect((await call('setSettings', { adultOn: true, adultAccepted: true })).e).toBeUndefined();
  expect((await call('adultList')).e, 'settings alone cannot turn it on').toMatch(/turned off/);
});

test('the main process checks the age itself', async () => {
  const kid = new Date(); kid.setFullYear(kid.getFullYear() - 17);
  const tooYoung = kid.toISOString().slice(0, 10);
  expect((await call('adultEnable', { birth: tooYoung, over18: true, ownLinks: true })).e).toMatch(/18 or older/);
  expect((await call('adultEnable', { birth: 'not a date', over18: true, ownLinks: true })).e).toMatch(/date of birth/);
  expect((await call('adultEnable', { birth: '1990-05-05', over18: false, ownLinks: true })).e).toMatch(/18 or older/);
  expect((await call('adultList')).e).toMatch(/turned off/);
});

test('Settings: date of birth and two ticks turn it on; the date is not kept', async () => {
  await page.locator('.topbar .nav button', { hasText: 'Settings' }).click();
  await page.locator('.settings-jump button', { hasText: 'Adults only' }).click();
  await page.locator('.settings-row', { hasText: '🔞 Adults only' }).getByRole('button', { name: 'Turn on…' }).click();
  const go = page.locator('.adult-consent').getByRole('button', { name: 'Turn on', exact: true });
  await expect(page.locator('.adult-consent')).toContainText('Nothing comes with it');
  await page.locator('.adult-birth').fill('2015-03-03');
  await page.locator('.adult-consent .consent-tick input').nth(0).check();
  await page.locator('.adult-consent .consent-tick input').nth(1).check();
  await expect(page.locator('.adult-consent')).toContainText('for people 18 or older');
  await expect(go, 'too young').toBeDisabled();
  await page.locator('.adult-birth').fill('1990-05-05');
  await expect(go).toBeEnabled();
  await go.click();
  await expect(nav()).toHaveCount(1);
  const s = settingsFile();
  expect(s.adultOn).toBe(true);
  expect(JSON.stringify(s)).not.toContain('1990');
});

test('its own place: add a playlist; only stations that answer are added', async () => {
  await nav().click();
  await expect(page.locator('.adult-view')).toContainText('Nothing here yet');
  const box = page.locator('.adult-add input');
  await box.fill(base + '/list.m3u');
  await page.locator('.adult-add').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.adult-card')).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator('.adult-card')).toContainText('Test Station');
  const again = (await call('adultAdd', base + '/list.m3u')).r;
  expect(again).toEqual({ added: 0, failed: 1, already: 1 });
  const one = (await call('adultAdd', base + '/b.mp4')).r;
  expect(one.added, 'a stream link on its own').toBe(1);
});

test('kept apart from every other list', async () => {
  const ids = (await call('adultList')).r.map((s) => s.id);
  expect(ids.length).toBe(2);
  const st = await page.evaluate(() => window.tv.state());
  expect(st.channels.filter((c) => ids.includes(c.id))).toEqual([]);
  expect((await call('iptvList')).r.filter((c) => ids.includes(c.id))).toEqual([]);
  expect(((await call('liveStations')).r || []).filter((c) => ids.includes(c.id))).toEqual([]);
});

test('a station plays, and is not remembered as the last channel', async () => {
  test.setTimeout(120000);
  if (!(await page.locator('.adult-view').count())) await nav().click();
  await page.locator('.adult-play', { hasText: 'Test Station' }).click();
  await page.waitForFunction(() => { const v = document.querySelector('.stage video'); return v && v.currentTime > 1; }, null, { timeout: 60000 });
  await expect(nav()).toHaveClass(/on/);
  const ids = (await call('adultList')).r.map((s) => s.id);
  expect(ids).not.toContain(settingsFile().lastChannel);
});

test('a child profile sees none of it', async () => {
  const id = (await call('adultList')).r[0].id;
  await page.evaluate(async () => { await window.tv.saveProfile({ name: 'Sam', level: 'kids' }); const v = await window.tv.profiles(); await window.tv.switchProfile(v.list.find((x) => x.name === 'Sam').id); });
  expect((await call('adultList')).e).toMatch(/turned off/);
  expect((await call('tune', id)).r, 'cannot tune it').toBeFalsy();
  await page.reload(); await page.waitForFunction(() => document.querySelector('.topbar, .picker, .modal'));
  await expect(nav()).toHaveCount(0);
  await page.evaluate(async () => { const v = await window.tv.profiles(); await window.tv.switchProfile(v.list.find((x) => x.level === 'adults').id); await window.tv.removeProfile?.(v.list.find((x) => x.name === 'Sam').id).catch(() => {}); });
  await page.reload(); await page.waitForSelector('.topbar');
  await page.locator('.modal-bg').first().click({ position: { x: 3, y: 3 } }).catch(() => {});
});

test('turned off while watching: the station goes, the button goes, the app refuses again', async () => {
  const id = (await call('adultList')).r[0].id;
  await page.mouse.move(300, 300); await page.mouse.move(320, 30); // wake the top bar
  if (!(await page.locator('.adult-view').count())) await nav().click();
  await page.locator('.adult-play').first().click();
  await page.waitForFunction(() => { const v = document.querySelector('.stage video'); return v && v.currentTime > 1; }, null, { timeout: 60000 });
  await page.locator('.topbar .nav button', { hasText: 'Settings' }).click();
  await page.locator('.settings-jump button', { hasText: 'Adults only' }).click();
  await page.locator('.settings-row', { hasText: '🔞 Adults only' }).getByRole('button', { name: 'Turn off' }).click();
  await expect(nav()).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.stage video'), 'the station is not left playing').toHaveCount(0);
  expect((await call('adultList')).e).toMatch(/turned off/);
  expect((await call('tune', id)).r).toBeFalsy();
  expect(settingsFile().adultOn).toBe(false);
});

test('back on, the stations are still there, and Remove all clears them', async () => {
  expect((await call('adultEnable', { birth: '1990-05-05', over18: true, ownLinks: true })).r).toBe(true);
  expect((await call('adultList')).r.length).toBe(2);
  expect((await call('adultRemoveAll')).r).toEqual([]);
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'channels.json'), 'utf8'));
  expect(JSON.stringify(saved)).not.toContain('Test Station');
});
