// Casts to a REAL Chromecast / Google TV on your network, through the app's UI:
// pick the TV, mid-show tune-in, channel change (a file the TV can't take as-is),
// pause, rewind, then stop casting and pick up on the PC. The TV is muted for the
// run and unmuted afterwards.
//   HOMECABLE_CAST=1 [HOMECABLE_CAST_TV="Living Room TV"] npx playwright test cast
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const SHOTS = path.join(__dirname, '..', 'test-results');
test.describe.configure({ mode: 'serial' });
test.skip(!process.env.HOMECABLE_CAST, 'set HOMECABLE_CAST=1 to cast to a real TV on your network');

let app, page, tvName;
const ffmpeg = require('ffmpeg-static');
function makeClip(out, codec) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const v = codec === 'mpeg4' ? ['-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'libmp3lame'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'];
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=25:d=300`, '-f', 'lavfi', '-i', 'sine=f=440:d=300', ...v, '-shortest', out]);
}

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-cast-'));
  const media = path.join(root, 'TV');
  // Two little shows: one the TV plays as-is (H.264 MP4), one HomeCable must convert (MPEG-4 Part 2 in MKV).
  for (const ep of [1, 2]) makeClip(path.join(media, 'Signal Show', 'Season 1', `Signal.Show.S01E0${ep}.mp4`), 'h264');
  for (const ep of [1, 2]) makeClip(path.join(media, 'Pattern Show', 'Season 1', `Pattern.Show.S01E0${ep}.mkv`), 'mpeg4');
  const env = { ...process.env, HOMECABLE_DATA: path.join(root, 'data'), HOMECABLE_MUTE: '1' };
  delete env.HOMECABLE_NO_CAST;
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }), env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 860));
  await page.waitForFunction(() => window.tv);
  await page.evaluate(async (folder) => {
    await window.tv.scan([folder]);
    const sug = await window.tv.suggest();
    await window.tv.createChannels(sug.filter((s) => /Signal Show|Pattern Show/.test(s.name)));
    await window.tv.setSettings({ setupDone: true });
  }, media);
  await page.reload();
  await expect(page.locator('.stage video')).toHaveCount(1, { timeout: 30000 });
  // Record what the TV reports.
  await page.evaluate(() => { window.__cast = []; window.tv.onCastMedia((s) => window.__cast.push(s)); });
});
test.afterAll(async () => {
  try { await page.evaluate(async () => { await window.tv.castControl('VOLUME', { muted: false }); await window.tv.castStop(); }); } catch {}
  await app?.close();
});

const tvState = () => page.evaluate(() => window.__cast.at(-1) || {});
const waitTv = (fn, timeout = 60000) => expect.poll(async () => fn(await tvState()), { timeout, intervals: [500] }).toBeTruthy();

test('the Cast button finds the TV and starts casting what is on', async () => {
  await page.keyboard.press('k');
  await expect(page.locator('.cast-menu')).toBeVisible();
  const dev = process.env.HOMECABLE_CAST_TV ? page.locator('.cast-dev', { hasText: process.env.HOMECABLE_CAST_TV }) : page.locator('button.cast-dev').first();
  await expect(dev).toBeVisible({ timeout: 15000 });
  tvName = (await dev.locator('b').innerText()).trim();
  // This test covers "Just the picture" (the video itself goes to the TV); mirroring has its own check.
  await page.locator('.cast-mode', { hasText: 'Just the picture' }).click();
  await page.screenshot({ path: path.join(SHOTS, 'cast-01-menu.png') });
  await dev.click();
  await expect(page.locator('.cast-screen')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.cast-screen .kicker')).toContainText(tvName);
  await page.evaluate(() => window.tv.castControl('VOLUME', { muted: true }));
  // Cable: you join the show in progress, not at the start.
  await waitTv((s) => s.playerState === 'PLAYING' && s.currentTime > 1);
  await page.screenshot({ path: path.join(SHOTS, 'cast-02-playing.png') });
  // The PC's own video stays silent and empty while the TV plays.
  expect(await page.evaluate(() => !document.querySelector('.stage video').getAttribute('src'))).toBe(true);
});

test('changing channels keeps casting (and converts what the TV can’t play)', async () => {
  const before = (await page.locator('.cast-screen .sub').innerText()).trim();
  const msid = (await tvState()).mediaSessionId;
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.cast-screen .sub')).not.toHaveText(before, { timeout: 15000 });
  await waitTv((s) => s.mediaSessionId > msid && s.playerState === 'PLAYING');
  await page.screenshot({ path: path.join(SHOTS, 'cast-03-channel-up.png') });
});

test('pause and rewind drive the TV', async () => {
  await page.keyboard.press(' ');
  await waitTv((s) => s.playerState === 'PAUSED', 20000);
  await page.keyboard.press(' ');
  await waitTv((s) => s.playerState === 'PLAYING', 30000);
  const msid = (await tvState()).mediaSessionId;
  for (let i = 0; i < 3; i++) await page.keyboard.press(',');
  await page.waitForTimeout(1500);
  // A converted stream restarts at the new point; a direct file seeks — either way the TV plays on.
  await waitTv((s) => s.playerState === 'PLAYING' && (s.mediaSessionId > msid || s.currentTime >= 0), 45000);
  await page.keyboard.press('i');
  await expect(page.locator('.banner .live-dot')).toHaveText(/REPLAY|PAUSED|LIVE/);
  await page.screenshot({ path: path.join(SHOTS, 'cast-04-rewound.png') });
});

test('stop casting: the picture comes back to this PC', async () => {
  await page.evaluate(() => window.tv.castControl('VOLUME', { muted: false })); // leave the TV as we found it
  await page.waitForTimeout(500);
  await page.keyboard.press('k');
  await page.locator('.cast-menu').getByRole('button', { name: 'Stop casting' }).click();
  await expect(page.locator('.cast-screen')).toHaveCount(0, { timeout: 15000 });
  await page.waitForFunction(() => { const v = document.querySelector('.stage video'); return v && v.currentTime > 0.5 && !v.paused; }, null, { timeout: 45000 });
  await page.screenshot({ path: path.join(SHOTS, 'cast-05-back-on-pc.png') });
});
