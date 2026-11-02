// Drives the real Electron app against a folder of sample media.
//   HOMECABLE_TEST_MEDIA=<folder> npx playwright test
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MEDIA = process.env.HOMECABLE_TEST_MEDIA;
const SHOTS = path.join(__dirname, '..', 'test-results');

test.describe.configure({ mode: 'serial' });
test.skip(!MEDIA || !fs.existsSync(MEDIA), 'set HOMECABLE_TEST_MEDIA to a folder of sample videos');

let app, page;
test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-e2e-'));
  // HOMECABLE_EXE=dist/win-unpacked/HomeCable.exe tests the packaged build instead of the source.
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }), env: { ...process.env, HOMECABLE_DATA: data, HOMECABLE_MUTE: '1' } });
  page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[renderer]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  // Size the real window (viewport emulation would pin the page size and break fullscreen).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 860));
});
test.afterAll(async () => { await app?.close(); });

test('first run shows the setup wizard', async () => {
  await expect(page.getByText('Set it all up for me', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: path.join(SHOTS, '01-welcome.png') });
});

test('scan finds the sample library and suggests channels', async () => {
  const r = await page.evaluate((m) => window.tv.scan([m]), MEDIA);
  expect(r.total).toBeGreaterThanOrEqual(8);
  const sugs = await page.evaluate(() => window.tv.suggest());
  expect(sugs.length).toBeGreaterThan(0);
});

// One channel per sample file so each format is exercised mid-program.
test('every format plays, joining mid-program', async () => {
  test.setTimeout(400000);
  const items = await page.evaluate(() => window.tv.items());
  const sugs = await page.evaluate(() => window.tv.suggest());
  await page.evaluate((list) => window.tv.createChannels(list), [
    ...sugs.filter((s) => s.recommended),
    ...items.map((it) => ({ name: 'T ' + it.path.split(/[\\/]/).pop(), order: 'ordered', align: 0, sources: [{ type: 'item', id: it.id }] })),
  ]);
  await page.evaluate(() => window.tv.setSettings({ setupDone: true }));
  await page.reload();
  await page.waitForSelector('.stage video');

  const channels = (await page.evaluate(() => window.tv.state())).channels.filter((c) => c.name.startsWith('T '));
  const results = [];
  for (const ch of channels) {
    await page.keyboard.press('Escape');
    // Type the channel number on the "remote".
    for (const d of String(ch.number)) await page.keyboard.press(d);
    await page.keyboard.press('Enter');
    let tuned = await page.evaluate((id) => window.tv.tune(id), ch.id);
    // Tuned in during a channel bumper (or a break): let it finish, then look again.
    for (let i = 0; i < 5 && tuned.entry && !tuned.play; i++) {
      await page.waitForTimeout(Math.min(12000, Math.max(500, tuned.entry.end - Date.now() + 400)));
      tuned = await page.evaluate((id) => window.tv.tune(id), ch.id);
    }
    const itemId = tuned.entry.itemId;
    // Wait for THIS item's source, then for real playback near the live position.
    const res = await page.waitForFunction(({ itemId, mode, offset }) => {
      const v = document.querySelector('.stage video');
      const err = document.querySelector('.error-screen');
      if (err) return { ok: false, why: err.textContent };
      if (!v || !v.currentSrc.includes('/' + itemId + '?')) return null;
      // Direct play seeks into the file; streams start at the live offset (time 0).
      const pos = mode === 'direct' ? v.currentTime : offset + v.currentTime;
      return v.currentTime > (mode === 'direct' ? 1 : 1.5) && !v.paused
        ? { ok: Math.abs(pos - offset) < 20, t: Math.round(v.currentTime), live: Math.round(pos), w: v.videoWidth, src: v.currentSrc.split('/')[3] } : null;
    }, { itemId, mode: tuned.play.mode, offset: tuned.offset }, { timeout: 45000, polling: 250 }).then((h) => h.jsonValue()).catch((e) => ({ ok: false, why: 'timeout ' + e.message.slice(0, 80) }));
    // Compare against where live TV is *now* (the item may have just looped).
    if (res.ok === false && res.live != null) {
      const again = await page.evaluate((id) => window.tv.tune(id), ch.id);
      if (again.play) {
        const v = await page.evaluate(() => document.querySelector('.stage video').currentTime);
        const pos = tuned.play.mode === 'direct' ? v : again.play.startedAt + v;
        res.ok = again.entry.itemId === itemId && Math.abs(pos - again.offset) < 20;
      }
    }
    results.push({ name: ch.name, mode: tuned.play?.mode, offset: Math.round(tuned.offset), ...res });
    if (ch.name.includes('.avi')) await page.screenshot({ path: path.join(SHOTS, '03-playing-transcode.png') });
    if (ch.name.includes('.mp3')) { await page.waitForTimeout(800); await page.screenshot({ path: path.join(SHOTS, '04-music.png') }); }
  }
  console.table(results);
  for (const r of results) expect(r.ok, `${r.name}: ${r.why}`).toBe(true);
});

test('banner, guide, channels, editor, library, settings render', async () => {
  const first = (await page.evaluate(() => window.tv.state())).channels[0];
  for (const d of String(first.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.mouse.move(700, 400);
  await page.keyboard.press('i');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, '02-watching.png') });

  await page.keyboard.press('g');
  await expect(page.locator('.grid-row').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '05-guide.png') });
  await page.keyboard.press('Escape');

  await page.keyboard.press('c');
  await expect(page.locator('.ch-card').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '06-channels.png') });
  // The first scheduled channel (On Demand channels have no time blocks).
  await page.locator('.ch-card').filter({ hasNot: page.locator('.od-badge') }).first().locator('button[title="Edit"]').click();
  await expect(page.locator('.section-title', { hasText: 'Time blocks' })).toBeVisible();
  await page.getByText('Add time block').click();
  await page.screenshot({ path: path.join(SHOTS, '07-editor.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.keyboard.press('l');
  await expect(page.getByText('Drag here to add to a channel')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '08-library.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await page.screenshot({ path: path.join(SHOTS, '09-settings.png') });
  await page.keyboard.press('Escape');
});

test('fullscreen toggles with F and leaves with Esc', async () => {
  await page.keyboard.press('f');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
});

test('controller works as the remote', async () => {
  const settings = () => page.evaluate(() => window.tv.state().then((s) => s.settings));
  const pad = async (...bs) => { for (const b of bs) { await page.evaluate((b) => window.__gamepadPress(b), b); await page.waitForTimeout(60); } };

  // Bumpers flip channels (triggers are rewind / fast-forward).
  const before = (await settings()).lastChannel;
  await pad('RB');
  await expect.poll(async () => (await settings()).lastChannel).not.toBe(before);
  const afterRb = (await settings()).lastChannel;
  await pad('LB');
  await expect.poll(async () => (await settings()).lastChannel).not.toBe(afterRb);

  // D-pad: up/down volume, left/right brightness, with an on-screen meter.
  // (On an On Demand channel the D-pad browses posters instead, so use a regular channel.)
  const regular = (await page.evaluate(() => window.tv.state())).channels.find((c) => !c.ondemand && !c.iptv);
  for (const d of String(regular.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await expect(page.locator('.ondemand')).toHaveCount(0);
  const v0 = (await settings()).volume;
  await pad('DOWN', 'DOWN');
  await expect.poll(async () => (await settings()).volume).toBeLessThan(v0);
  await pad('RIGHT', 'RIGHT');
  await expect.poll(async () => (await settings()).brightness).toBeGreaterThan(1);
  await expect(page.locator('.osd-level')).toBeVisible();
  expect(await page.locator('.stage video').getAttribute('style')).toContain('brightness(1.1)');
  await expect(page.locator('.pad-legend.show')).toContainText('Brightness');
  await page.screenshot({ path: path.join(SHOTS, '10-controller-tv.png') });
  await pad('LEFT', 'LEFT');

  // B is one-button mute / unmute while watching.
  const m0 = !!(await settings()).muted;
  await pad('B');
  await expect.poll(async () => !!(await settings()).muted).toBe(!m0);
  await expect(page.locator('.mute-badge')).toHaveCount(m0 ? 0 : 1);
  await pad('B');
  await expect.poll(async () => !!(await settings()).muted).toBe(m0);

  // Menu button: guide on and off.
  await pad('MENU');
  await expect(page.locator('.overlay.guide')).toBeVisible();
  await pad('DOWN', 'A');
  await pad('MENU');
  await expect(page.locator('.overlay.guide')).toHaveCount(0);

  // Y opens the menus; D-pad moves a focus ring; LB/RB switch tabs.
  await pad('Y');
  await expect(page.locator('.overlay h2')).toHaveText('Settings');
  await pad('DOWN');
  await expect(page.locator('.gp-focus')).toHaveCount(1);
  await pad('RB');
  await expect(page.locator('.overlay h2')).not.toHaveText('Settings');

  // Edit a channel entirely from the pad: name via on-screen keyboard, number via adjust.
  await expect(page.locator('.overlay h2')).toHaveText('Channels'); // RB from Settings wraps to Channels
  await page.locator('.ch-card').first().locator('button[title="Edit"]').click();
  await pad('DOWN'); // focus lands in the dialog
  // Walk to the name field (first input in the dialog).
  for (let i = 0; i < 12 && !(await page.evaluate(() => document.querySelector('.gp-focus')?.matches('.modal input'))); i++) await pad('UP');
  if (await page.evaluate(() => document.querySelector('.gp-focus')?.type === 'number')) await pad('LEFT');
  expect(await page.evaluate(() => document.querySelector('.gp-focus')?.type)).toBe('text');
  await pad('A');
  await expect(page.locator('.osk')).toBeVisible();
  await pad('X', 'X', 'X'); // delete three letters
  await pad('A'); // type the highlighted key ("q")
  await page.screenshot({ path: path.join(SHOTS, '12-controller-keyboard.png') });
  await pad('MENU');
  await expect(page.locator('.osk')).toHaveCount(0);
  expect(await page.locator('.modal input.input').first().inputValue()).toMatch(/q$/);
  await pad('RIGHT', 'A'); // number field: grab it
  await expect(page.locator('.gp-adjust')).toHaveCount(1);
  const n0 = +(await page.locator('.gp-adjust').inputValue());
  await pad('UP', 'UP', 'A');
  expect(+(await page.locator('.modal input[type=number]').inputValue())).toBe(n0 + 2);
  await pad('B'); // close dialog without saving
  await expect(page.locator('.modal')).toHaveCount(0);

  // Menu from any panel goes straight back to TV.
  await pad('MENU');
  await expect(page.locator('.overlay')).toHaveCount(0);
});

test('menus draw above the picture in fullscreen', async () => {
  await page.keyboard.press('f');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await page.waitForTimeout(800);
  const dims = await page.evaluate(() => {
    const r = document.querySelector('.stage video').getBoundingClientRect();
    return { iw: innerWidth, ih: innerHeight, sw: screen.width, sh: screen.height, vw: Math.round(r.width), vh: Math.round(r.height) };
  });
  console.log('fullscreen dims', JSON.stringify(dims));
  expect(Math.abs(dims.iw - dims.sw)).toBeLessThan(4);
  expect(Math.abs(dims.ih - dims.sh)).toBeLessThan(4);
  expect(dims.vw).toBe(dims.iw);
  await page.screenshot({ path: path.join(SHOTS, '13a-fullscreen-tv.png') });
  await page.keyboard.press('s');
  await expect(page.locator('.stage.covered')).toHaveCount(1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '13-fullscreen-settings.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('.stage.covered')).toHaveCount(0);
  await page.keyboard.press('g');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '14-fullscreen-guide.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
});

test('single channel mode locks the TV to one channel', async () => {
  const state = await page.evaluate(() => window.tv.state());
  const target = state.channels[1];
  await page.keyboard.press('s');
  await page.locator('select').first().selectOption(target.id);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.tv.state().then((s) => s.settings.lastChannel))).toBe(target.id);
  await page.keyboard.press('ArrowUp');
  await page.evaluate(() => window.__gamepadPress('RB'));
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.tv.state().then((s) => s.settings.lastChannel))).toBe(target.id);
  await page.keyboard.press('g');
  await expect(page.locator('.grid-row')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.move(600, 300);
  await page.screenshot({ path: path.join(SHOTS, '11-single-channel.png') });
});

test('DVR: rewind within what you have watched, fast-forward to live', async () => {
  test.setTimeout(120000);
  const chs = (await page.evaluate(() => window.tv.state())).channels;
  await page.evaluate(() => window.tv.setSettings({ lockChannel: null }));
  await page.reload();
  await page.waitForSelector('.stage video');
  const behind = () => page.evaluate(() => {
    const v = document.querySelector('.stage video');
    return v ? v.currentTime : 0;
  });
  for (const pick of ['.mp4', '.avi']) {
    const ch = chs.find((c) => c.name.startsWith('T ') && c.name.endsWith(pick));
    for (const d of String(ch.number)) await page.keyboard.press(d);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => { const v = document.querySelector('.stage video'); return v && v.currentTime > 0.5 && !v.paused; }, null, { timeout: 30000 });
    // Just tuned in: nothing to rewind into yet.
    const t0 = await behind();
    await page.keyboard.press(',');
    await page.waitForTimeout(900);
    const t1 = await behind();
    expect(t1).toBeGreaterThan(t0 - 3);
    // Watch for a bit, pause, then rewind into what we saw.
    await page.waitForTimeout(6000);
    await page.keyboard.press(' ');
    await page.waitForTimeout(3000);
    await expect(page.locator('.dvr')).toBeVisible();
    await page.keyboard.press(' ');
    await page.keyboard.press(',');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, `15-dvr${pick.replace('.', '-')}.png`) });
    const lag = await page.evaluate(() => document.querySelector('.dvr-time')?.textContent);
    expect(lag, 'shows time behind live').toMatch(/^−\d/);
    // Fast-forward past live snaps to live.
    for (let i = 0; i < 4; i++) await page.keyboard.press('.');
    await page.waitForTimeout(1500);
    await expect(page.locator('.dvr-time')).toHaveText('LIVE');
  }
});
