// Free live TV, end to end, with sound — watchable. Adds every working station
// it finds (country list + popular categories), then flips through all of them.
//   HOMECABLE_NET=1 npx playwright test iptv
//   HOMECABLE_IPTV_MAX=60  HOMECABLE_IPTV_DWELL=6000  to change how many / how long each
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const SHOTS = path.join(__dirname, '..', 'test-results');
const MAX = +(process.env.HOMECABLE_IPTV_MAX || 60);
const DWELL = +(process.env.HOMECABLE_IPTV_DWELL || 5000);
test.describe.configure({ mode: 'serial' });
test.skip(!process.env.HOMECABLE_NET, 'needs HOMECABLE_NET=1 (internet)');

const ffmpegCount = () => { try { return (execSync('tasklist /FI "IMAGENAME eq ffmpeg.exe" /NH', { encoding: 'utf8' }).match(/ffmpeg\.exe/gi) || []).length; } catch { return 0; } };

let app, page;
test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-iptv-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ setupDone: true, onlineMeta: false, bannerSeconds: 3 }));
  const env = { ...process.env, HOMECABLE_DATA: data };
  delete env.HOMECABLE_MUTE; // sound on
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }), env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 860));
});
test.afterAll(async () => { await app?.close(); });

test(`find and add up to ${MAX} working free stations`, async () => {
  test.setTimeout(900000);
  const progress = [];
  await page.exposeFunction('__iptvLog', (p) => progress.push(p));
  await page.evaluate(() => window.tv.onIptvProgress((p) => window.__iptvLog(p)));
  await page.evaluate((max) => window.tv.iptvAuto({ country: 'us', languages: ['eng'], categories: ['movies', 'news', 'kids', 'sports', 'music', 'comedy'], max }), MAX);
  await expect.poll(() => progress.some((p) => p.running === false), { timeout: 840000, intervals: [5000] }).toBe(true);
  const last = progress[progress.length - 1];
  const s = await page.evaluate(() => window.tv.state());
  const live = s.channels.filter((c) => c.iptv);
  console.log(`checked ${last.checked} of ${last.total} candidate stations → ${live.length} working stations added`);
  expect(live.length).toBeGreaterThan(5);
  await page.keyboard.press('c');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, 'iptv-01-lineup.png') });
  await page.keyboard.press('Escape');
});

test('flip through every station', async () => {
  test.setTimeout(MAX * (DWELL + 50000));
  const live = (await page.evaluate(() => window.tv.state())).channels.filter((c) => c.iptv);
  const results = [];
  for (const ch of live) {
    const t0 = Date.now();
    for (const d of String(ch.number)) await page.keyboard.press(d);
    await page.keyboard.press('Enter');
    // Plays, or shows the off-the-air card — never hangs.
    const r = await page.waitForFunction((id) => {
      const v = document.querySelector('.stage video');
      if (document.querySelector('.error-screen')) return { ok: false, why: 'off the air' };
      return v && v.currentSrc.includes('/live/' + id) && v.currentTime > 0.3 && !v.paused ? { ok: true, w: v.videoWidth, h: v.videoHeight, audioOnly: !v.videoWidth } : null;
    }, ch.id, { timeout: 40000, polling: 250 }).then((h) => h.jsonValue()).catch(() => ({ ok: false, why: 'no picture in 40 s' }));
    results.push({ ch: ch.number, name: ch.name.slice(0, 34), group: (ch.iptv.group || '').slice(0, 18), ok: r.ok, tune: `${((Date.now() - t0) / 1000).toFixed(1)}s`, size: r.ok ? (r.audioOnly ? 'audio' : `${r.w}x${r.h}`) : r.why });
    if (results.length <= 4 || results.length % 10 === 0) await page.screenshot({ path: path.join(SHOTS, `iptv-tv-${ch.number}.png`) });
    await page.waitForTimeout(DWELL);
  }
  console.table(results);
  const ok = results.filter((r) => r.ok).length;
  console.log(`${ok} of ${results.length} stations played`);
  // Stations are checked when added, but free streams come and go — most must play.
  expect(ok).toBeGreaterThanOrEqual(Math.ceil(results.length * 0.7));
  // Channel changes stop the old stream: no ffmpeg pile-up.
  expect(ffmpegCount()).toBeLessThanOrEqual(3);
});

test('guide shows the live stations; off-air stations get flagged', async () => {
  test.setTimeout(240000);
  await page.keyboard.press('g');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, 'iptv-02-guide.png') });
  await page.keyboard.press('g');
  // A station that's gone: shows "off the air" instead of hanging, and gets flagged.
  const [dead] = await page.evaluate(() => window.tv.iptvAdd([{ name: 'Gone Station', url: 'https://127.0.0.1:9/nothing.m3u8', logo: '', group: 'Test', check: { ok: true, video: 'h264' } }]).then((l) => l.filter((c) => c.name === 'Gone Station')));
  for (const d of String(dead.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  // It isn't offered: it gets hidden and you land on the next working channel.
  await expect(page.locator('.toast')).toContainText('Gone Station is off the air', { timeout: 90000 });
  await page.screenshot({ path: path.join(SHOTS, 'iptv-03-off-air.png') });
  await expect.poll(async () => (await page.evaluate(() => window.tv.state())).channels.find((c) => c.name === 'Gone Station').iptv.dead, { timeout: 30000 }).toBeTruthy();
  await expect.poll(async () => (await page.evaluate(() => window.tv.state())).settings.lastChannel).not.toBe(dead.id);
  // Not in the guide either.
  await page.keyboard.press('g');
  await expect(page.locator('.grid-row', { hasText: 'Gone Station' })).toHaveCount(0);
  await page.keyboard.press('g');
  const r = await page.evaluate(() => window.tv.iptvRemoveDead());
  expect(r.removed).toBeGreaterThanOrEqual(1);
});

test('program guides, mixing a live show into your channel, and channel numbers', async () => {
  test.setTimeout(400000);
  // Real listings for live stations.
  const n = await page.evaluate(() => window.tv.refreshGuides());
  console.log(`program guides found for ${n} stations`);
  const stations = await page.evaluate(() => window.tv.liveStations());
  const withGuide = stations.filter((s) => s.now && !s.dead);
  console.log(withGuide.slice(0, 8).map((s) => `  ${s.number} ${s.name}: now “${s.now}”`).join('\n'));
  const station = withGuide[0] || stations.find((s) => !s.dead);
  // One of your own channels (empty outside its blocks).
  await page.evaluate(() => window.tv.createChannels([{ name: 'My Mix', number: 7, sources: [], align: 30 }]));
  const mine = (await page.evaluate(() => window.tv.state())).channels.find((c) => c.name === 'My Mix');
  // In the guide: highlight the station's current programme, press M, mix it in.
  await page.keyboard.press('g');
  await expect(page.locator('.overlay.guide')).toBeVisible();
  await page.locator('.grid-row', { hasText: station.name }).locator('.cell.on-now').first().dispatchEvent('click');
  await page.keyboard.press('m');
  await expect(page.getByText('Mix into a channel').last()).toBeVisible();
  await page.locator('.modal select').selectOption(mine.id);
  await page.getByRole('button', { name: 'Just this time' }).click();
  await page.screenshot({ path: path.join(SHOTS, 'iptv-04-mix-dialog.png') });
  await page.getByRole('button', { name: 'Add to channel' }).click();
  await expect(page.locator('.toast')).toContainText('will air on');
  await page.keyboard.press('g');
  // Tune your channel: right now it's playing the live station inside your schedule.
  for (const d of String(mine.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  const ok = await page.waitForFunction((id) => { const v = document.querySelector('.stage video'); return v && v.currentSrc.includes('/live/' + id) && v.currentTime > 0.3; }, station.id, { timeout: 60000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS, 'iptv-05-mixed-on-my-channel.png') });
  expect(ok, 'live station plays inside your channel').toBe(true);
  const block = (await page.evaluate(() => window.tv.state())).channels.find((c) => c.id === mine.id).blocks[0];
  expect(block.sources[0].type).toBe('live');
  expect(block.date).toBeTruthy();
  // Channel numbers: move the live range, then give one station a number by hand.
  await page.evaluate(() => window.tv.liveRenumber(500));
  let s = await page.evaluate(() => window.tv.state());
  expect(Math.min(...s.channels.filter((c) => c.iptv).map((c) => c.number))).toBe(500);
  await page.keyboard.press('c');
  await page.locator('.ch-card', { hasText: station.name }).locator('.num-btn').click();
  await page.locator('.num-input').fill('42');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await page.evaluate(() => window.tv.state())).channels.find((c) => c.id === station.id).number).toBe(42);
  await page.screenshot({ path: path.join(SHOTS, 'iptv-06-channel-numbers.png') });
  await page.keyboard.press('Escape');
});
