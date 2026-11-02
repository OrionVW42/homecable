// "Set it all up for me" on a fresh install, with the defaults (free TV on).
//   HOMECABLE_SAMPLES=<folder> HOMECABLE_NET=1 npx playwright test auto
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SAMPLES = process.env.HOMECABLE_SAMPLES;
const SHOTS = path.join(__dirname, '..', 'test-results');
test.skip(!SAMPLES || !process.env.HOMECABLE_NET, 'needs HOMECABLE_SAMPLES and HOMECABLE_NET=1');

test('automatic setup builds a full lineup: your media + free TV', async () => {
  test.setTimeout(600000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-auto-'));
  const app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }),
    env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_QUICK_ROOTS: SAMPLES, HOMECABLE_MUTE: '1' } });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 860));
  // "Set it all up for me": every step is filled in — check it and press Next.
  await page.getByText('Set it all up for me', { exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // who watches
  await page.waitForFunction(() => !document.querySelector('.sources .progress'), null, { timeout: 60000 }).catch(() => {});
  await page.getByRole('button', { name: /^(Look through|Next)/ }).click(); // your media → scan
  await expect(page.getByText('Here’s what we found')).toBeVisible({ timeout: 300000 });
  await page.screenshot({ path: path.join(SHOTS, 'auto-00-found.png') });
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // what we found
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // free TV (defaults on)
  await expect(page.getByText('The stuff between the shows')).toBeVisible(); // Showtime: bumpers & the wacky ads
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // showtime
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // how it runs
  await expect(page.getByText('Here’s what will happen')).toBeVisible();
  await page.getByRole('button', { name: 'Set it up' }).click();
  await expect(page.getByText('You’re on the air.')).toBeVisible({ timeout: 480000 });
  await page.screenshot({ path: path.join(SHOTS, 'auto-01-done.png') });
  await page.getByRole('button', { name: 'Start watching' }).click();
  // A fresh setup is followed by the one-time welcome tour - skip it.
  await expect(page.locator('.tour')).toBeVisible();
  await page.locator('.tour-skip').click();
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.waitForFunction(() => { const v = document.querySelector('.stage video'); return v && v.currentTime > 0.5; }, null, { timeout: 60000 });
  // Live stations keep arriving in the background.
  await expect.poll(async () => (await page.evaluate(() => window.tv.state())).channels.filter((c) => c.iptv).length, { timeout: 300000, intervals: [5000] }).toBeGreaterThan(2);
  const s = await page.evaluate(() => window.tv.state());
  console.log('lineup:\n' + s.channels.map((c) => `  ${c.number} ${c.name}${c.iptv ? ' (live)' : ''}`).slice(0, 25).join('\n') + `\n  … ${s.channels.length} channels total`);
  expect(s.channels.some((c) => c.name === 'Classic Movies')).toBe(true);
  expect(s.channels.some((c) => c.name === 'Movie Channel')).toBe(true);
  expect(s.settings.newMedia).toBe('auto');
  expect(s.settings.adsOn).toBeFalsy();
  await page.keyboard.press('g');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, 'auto-02-guide.png') });
  await app.close();
});
