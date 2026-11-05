// Builds channels from a real media folder through the actual UI, with sound on,
// then flips through them. Watchable: each channel stays up a few seconds.
//   HOMECABLE_SAMPLES="C:\Users\you\Videos\HomeCable Samples" npx playwright test channels
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SAMPLES = process.env.HOMECABLE_SAMPLES;
const SHOTS = path.join(__dirname, '..', 'test-results');
const DWELL = +(process.env.HOMECABLE_DWELL || 5000);

test.describe.configure({ mode: 'serial' });
test.skip(!SAMPLES || !fs.existsSync(SAMPLES), 'set HOMECABLE_SAMPLES to a folder of videos');

let app, page;
test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'homecable-channels-'));
  // Sound ON for this one (no HOMECABLE_MUTE).
  const env = { ...process.env, HOMECABLE_DATA: data };
  if (!process.env.HOMECABLE_OFFSCREEN) delete env.HOMECABLE_MUTE; // off-screen runs stay silent
  app = await electron.launch({ ...(process.env.HOMECABLE_EXE ? { executablePath: process.env.HOMECABLE_EXE, args: [] } : { args: [path.join(__dirname, '..')] }), env });
  page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 860));
  // "I'll pick the folders" opens a Windows folder dialog; answer it with the samples folder.
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, SAMPLES);
});
test.afterAll(async () => { await app?.close(); });

// Watching: a picture playing with sound — or, on an On Demand channel, its poster wall.
const watching = () => page.waitForFunction(() => {
  if (document.querySelector('.ondemand .od-tile, .ondemand .od-empty')) return true;
  const v = document.querySelector('.stage video');
  return v && v.currentTime > 0.5 && !v.paused && !v.muted && v.volume > 0;
}, null, { timeout: 45000, polling: 250 });

test('setup wizard: choose sources, options and lineup', async () => {
  await page.getByText('I’ll do it myself', { exact: true }).click();
  // Who watches? (people can be added later — keep the single grown-up)
  await expect(page.getByText('Who watches?')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'setup-00-people.png') });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Sources: everything found is pre-ticked; untick it and add just the samples folder.
  await expect(page.locator('.src-group').first()).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.sources .progress'), null, { timeout: 30000 });
  await page.screenshot({ path: path.join(SHOTS, 'setup-01-sources.png') });
  for (let n = await page.locator('.src-row.on').count(); n > 0; n = await page.locator('.src-row.on').count()) await page.locator('.src-row.on').first().click();
  await page.getByRole('button', { name: 'Choose a folder…' }).click();
  await expect(page.locator('.src-row.on')).toHaveCount(1);
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // your videos
  await expect(page.getByText('Pick-and-play folders')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Any private videos?')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Posters and privacy', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /^Look through 1 source$/ }).click();
  // What we found: start empty (doing it myself), then take HomeCable's best guess.
  await expect(page.getByText('Here’s what we found')).toBeVisible({ timeout: 180000 });
  await page.screenshot({ path: path.join(SHOTS, 'setup-01b-found-empty.png') });
  await page.getByRole('button', { name: /best guess/ }).click();
  await page.screenshot({ path: path.join(SHOTS, 'setup-02-found.png') });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // Free TV: off for this run (network-dependent; covered by the free-TV test).
  await expect(page.getByText('Free TV from the internet')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'setup-03-free.png') });
  while (await page.locator('.freetv .toggle.on').count()) await page.locator('.freetv .toggle.on').first().click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  // The Showtime page (bumpers & wacky ads) sits between free TV and options.
  await expect(page.getByText('The stuff between the shows')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('How should channels play?')).toBeVisible();
  // Back to back: something is always playing (cable timing can sit on "Up next" until the half hour).
  await page.getByRole('button', { name: /Back to back/ }).click();
  for (const screen of ['When you add new videos', 'Subtitles and sound', 'The picture', 'Watching on other screens', 'Keeping it up to date', 'Torrents']) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { name: screen })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Here’s what will happen')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'ch-01-summary.png') });
  await page.getByRole('button', { name: 'Set it up' }).click();
  await page.getByRole('button', { name: 'Start watching' }).click({ timeout: 180000 });
  // A fresh setup is followed by the one-time welcome tour - skip it.
  await expect(page.locator('.tour')).toBeVisible();
  await page.locator('.tour-skip').click();
  await expect(page.locator('.tour')).toHaveCount(0);
  await expect(page.locator('.setup')).toHaveCount(0);
  // Channel 1 is On Demand (a poster wall): flip to the first scheduled channel to watch.
  const first = (await page.evaluate(() => window.tv.state())).channels.find((c) => !c.ondemand && !c.iptv);
  for (const d of String(first.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await watching();
  const s = await page.evaluate(() => window.tv.state());
  console.log('suggested channels:', s.channels.map((c) => `${c.number} ${c.name}`).join(' | '));
  expect(s.channels.length).toBeGreaterThan(0);
  expect(s.settings.muted).toBeFalsy();
  expect(s.settings.newMedia).toBe('auto');
});

test('library: browse, play on demand, drag onto a channel', async () => {
  await page.keyboard.press('l');
  await expect(page.locator('.lib-card').first()).toBeVisible();
  await page.waitForTimeout(2500); // let thumbnails render
  await page.screenshot({ path: path.join(SHOTS, 'lib-01-grid.png') });
  // Drag "Penalti" onto the first channel in the rail.
  const card = page.locator('.lib-card', { hasText: 'Penalti' }).first();
  const target = page.locator('.rail-ch').first();
  const chName = (await target.textContent()).trim();
  await card.dragTo(target);
  await expect(page.locator('.toast')).toContainText('Penalti');
  const ch = (await page.evaluate(() => window.tv.state())).channels.find((c) => chName.includes(c.name));
  expect(ch.sources.some((x) => x.type === 'item' && x.label === 'Penalti')).toBe(true);
  // Play a movie on demand, seek, and come back.
  await page.locator('.lib-card', { hasText: 'Sintel' }).first().hover();
  await page.locator('.lib-card', { hasText: 'Sintel' }).first().locator('.lib-play').click();
  await expect(page.locator('.stage[data-vod]')).toHaveCount(1);
  await watching();
  await page.keyboard.press('.'); await page.keyboard.press('.'); await page.keyboard.press('.');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, 'lib-02-on-demand.png') });
  await page.waitForTimeout(DWELL);
  await page.keyboard.press('Escape');
  await expect(page.locator('.overlay.lib')).toBeVisible();
  await expect(page.locator('.stage[data-vod]')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('make a channel by hand in the editor', async () => {
  await page.keyboard.press('c');
  await page.getByRole('button', { name: 'New channel' }).click();
  await page.locator('.modal input.input').first().fill('Meme TV');
  await page.locator('.modal .swatches button[title="#e0558a"]').click();
  await page.locator('.modal .swatches button', { hasText: '😂' }).click();
  // What plays: every short clip, as individual picks.
  await page.locator('.modal .btn.sm', { hasText: 'Add' }).first().click();
  await page.getByRole('button', { name: 'Movies & videos' }).click();
  const shorts = page.locator('.pick-item', { hasText: /^short ·|short ·/ });
  const n = await shorts.count();
  for (let i = 0; i < n; i++) await shorts.nth(i).click();
  await page.screenshot({ path: path.join(SHOTS, 'ch-02-picking.png') });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Shuffle everything' }).click();
  await page.getByRole('button', { name: 'back-to-back' }).click();
  await expect(page.locator('.modal')).toContainText(`${n} videos`);
  await page.screenshot({ path: path.join(SHOTS, 'ch-03-editor.png') });
  await page.getByRole('button', { name: 'Save channel' }).click();
  await expect(page.locator('.ch-card', { hasText: 'Meme TV' })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'ch-04-lineup.png') });
  expect(n).toBeGreaterThan(3);
  // Watch it.
  await page.locator('.ch-card', { hasText: 'Meme TV' }).locator('button[title="Watch"]').click();
  await watching();
  await page.waitForTimeout(DWELL);
});

test('flip through every channel with sound', async () => {
  test.setTimeout(400000);
  const chs = (await page.evaluate(() => window.tv.state())).channels;
  const seen = [];
  for (const ch of chs) {
    for (const d of String(ch.number)) await page.keyboard.press(d);
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => window.tv && document.querySelector('.banner.show') && true, ch.id, { timeout: 10000 });
    const t = await page.evaluate((id) => window.tv.tune(id), ch.id);
    if (t.play) await watching();
    await page.waitForTimeout(600);
    const op = await page.evaluate(() => getComputedStyle(document.querySelector('.banner')).opacity);
    seen.push(`${ch.number} ${ch.name}: ${t.entry?.title} (${t.play?.mode || t.entry?.type}) banner opacity ${op}`);
    expect(op).toBe('1');
    await page.screenshot({ path: path.join(SHOTS, `ch-tv-${ch.number}.png`) });
    await page.waitForTimeout(DWELL);
  }
  console.log(seen.join('\n'));
  await page.keyboard.press('g');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, 'ch-05-guide.png') });
  await page.keyboard.press('g');
});

// A guided tour with the (simulated) controller — slow enough to watch.
test('full tour with the controller', async () => {
  test.setTimeout(600000);
  const pad = async (b, wait = 700) => { await page.evaluate((b) => window.__gamepadPress(b), b); await page.waitForTimeout(wait); };
  const state = () => page.evaluate(() => window.tv.state());
  const nowOn = () => page.evaluate(() => document.querySelector('.controls .t')?.textContent || document.querySelector('.banner .now')?.textContent);
  const step = (s) => console.log('▶', s);
  const meme = (await state()).channels.find((c) => c.name === 'Meme TV');

  step('Meme TV: waiting for the next clip to start on its own');
  await page.evaluate((id) => window.tv.tune(id), meme.id);
  for (const d of String(meme.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await watching();
  const first = await page.evaluate((id) => window.tv.tune(id), meme.id);
  const left = first.entry.end - Date.now();
  step(`  on now: ${first.entry.title}, next: ${first.next?.title} in ${Math.round(left / 1000)}s`);
  await page.waitForFunction((end) => Date.now() > end + 1500, first.entry.end, { timeout: left + 20000, polling: 1000 });
  await watching();
  const second = await page.evaluate((id) => window.tv.tune(id), meme.id);
  step(`  now playing: ${second.entry.title}`);
  expect(second.entry.start).toBeGreaterThanOrEqual(first.entry.end);
  await page.screenshot({ path: path.join(SHOTS, 'tour-01-next-clip.png') });

  step('RB / LB: flipping channels');
  const startCh = (await state()).settings.lastChannel;
  await pad('RB', 2500);
  // Flipping can wrap round to channel 1, On Demand: that shows its poster wall instead of playing.
  { const st = await state(); const cur = st.channels.find((c) => c.id === st.settings.lastChannel);
    if (cur?.ondemand) await expect(page.locator('.ondemand')).toBeVisible(); else await watching(); }
  step(`  ${await nowOn()}`);
  await pad('RB', 2500); step(`  ${await nowOn()}`);
  await pad('LB', 2500); await pad('LB', 2500);
  expect((await state()).settings.lastChannel).toBe(startCh);

  step('D-pad: volume down/up, brightness down/up');
  const v0 = (await state()).settings.volume;
  for (let i = 0; i < 4; i++) await pad('DOWN', 250);
  expect((await state()).settings.volume).toBeLessThan(v0);
  for (let i = 0; i < 4; i++) await pad('UP', 250);
  expect((await state()).settings.volume).toBeCloseTo(v0, 2);
  for (let i = 0; i < 4; i++) await pad('LEFT', 250);
  await page.screenshot({ path: path.join(SHOTS, 'tour-02-brightness.png') });
  for (let i = 0; i < 4; i++) await pad('RIGHT', 250);
  expect((await state()).settings.brightness).toBeCloseTo(1, 2);

  step('B: mute, then unmute');
  await pad('B', 1500);
  expect((await state()).settings.muted).toBe(true);
  await page.screenshot({ path: path.join(SHOTS, 'tour-03-muted.png') });
  await pad('B', 1000);
  expect((await state()).settings.muted).toBe(false);

  step('R3: picture size Fit → Fill → Stretch → Fit');
  for (const mode of ['fill', 'stretch', 'fit']) {
    await pad('RS', 1500);
    expect(await page.locator('.stage').getAttribute('data-fit')).toBe(mode);
  }

  step('Menu: guide; D-pad down, A to tune');
  await pad('MENU', 1500);
  await expect(page.locator('.overlay.guide')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'tour-04-guide.png') });
  await pad('DOWN', 900);
  await pad('A', 1500);
  await pad('MENU', 1500);
  await expect(page.locator('.overlay.guide')).toHaveCount(0);
  await watching();

  step('X: pause; LT: rewind; RT: back to live');
  await page.waitForTimeout(8000); // build up some buffer to rewind into
  await pad('X', 3000);
  await expect(page.locator('.dvr')).toBeVisible();
  await pad('X', 500);
  for (let i = 0; i < 3; i++) await pad('LT', 300);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, 'tour-05-rewind.png') });
  expect(await page.locator('.dvr-time').textContent()).toMatch(/^−/);
  for (let i = 0; i < 4; i++) await pad('RT', 300);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => document.querySelector('.dvr-time')?.textContent ?? 'LIVE')).toBe('LIVE');

  step('View: fullscreen and back');
  await pad('VIEW', 2500);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await page.screenshot({ path: path.join(SHOTS, 'tour-06-fullscreen.png') });
  await page.waitForTimeout(DWELL);
  await pad('VIEW', 1500);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);

  step('Y: menus — single channel mode on via the controller, then off');
  await pad('Y', 1200);
  await expect(page.locator('.overlay h2')).toHaveText('Settings');
  // Walk down to the single-channel picker.
  for (let i = 0; i < 25 && (await page.evaluate(() => document.querySelector('.gp-focus')?.tagName)) !== 'SELECT'; i++) await pad('DOWN', 250);
  expect(await page.evaluate(() => document.querySelector('.gp-focus')?.tagName)).toBe('SELECT');
  await pad('A', 500); await pad('DOWN', 600); await pad('A', 800); // grab, next option, let go
  const locked = (await state()).settings.lockChannel;
  expect(locked).toBeTruthy();
  await page.screenshot({ path: path.join(SHOTS, 'tour-07-single-channel.png') });
  await pad('MENU', 1500);
  await pad('RB', 1500);                        // flipping is off now
  expect((await state()).settings.lastChannel).toBe(locked);
  await pad('Y', 1000);
  for (let i = 0; i < 25 && (await page.evaluate(() => document.querySelector('.gp-focus')?.tagName)) !== 'SELECT'; i++) await pad('DOWN', 250);
  await pad('A', 400); await pad('UP', 500); await pad('A', 600);
  expect((await state()).settings.lockChannel).toBeFalsy();
  await pad('MENU', 1500);
  step('tour done');
});

test('full tour with the keyboard', async () => {
  test.setTimeout(300000);
  const k = async (key, wait = 700) => { await page.keyboard.press(key); await page.waitForTimeout(wait); };
  const state = () => page.evaluate(() => window.tv.state());
  const step = (s) => console.log('⌨', s);
  const chs = (await state()).channels;

  step('↑ / ↓ flip channels, number + Enter, Backspace = previous');
  // Start on a regular channel: on the On Demand wall the arrows browse posters instead.
  const regular = chs.find((c) => !c.ondemand && !c.iptv);
  for (const d of String(regular.number)) await k(d, 150);
  await k('Enter', 2000);
  const start = (await state()).settings.lastChannel;
  await k('ArrowUp', 2000); await watching();
  expect((await state()).settings.lastChannel).not.toBe(start);
  await k('ArrowDown', 2000);
  expect((await state()).settings.lastChannel).toBe(start);
  const target = chs.find((c) => c.id !== start);
  for (const d of String(target.number)) await k(d, 150);
  await k('Enter', 2000);
  expect((await state()).settings.lastChannel).toBe(target.id);
  await k('Backspace', 2000);
  expect((await state()).settings.lastChannel).toBe(start);

  step('← → volume, M mute, [ ] brightness, Z picture size, I info');
  const v0 = (await state()).settings.volume;
  await k('ArrowLeft', 300); await k('ArrowLeft', 300);
  expect((await state()).settings.volume).toBeLessThan(v0);
  await k('ArrowRight', 300); await k('ArrowRight', 600);
  await k('m', 1200); expect((await state()).settings.muted).toBe(true);
  await expect(page.locator('.mute-badge')).toBeVisible();
  await k('m', 600); expect((await state()).settings.muted).toBe(false);
  await k(']', 300); await k(']', 900);
  expect((await state()).settings.brightness).toBeGreaterThan(1);
  await k('[', 300); await k('[', 600);
  for (const mode of ['fill', 'stretch', 'fit']) { await k('z', 1200); expect(await page.locator('.stage').getAttribute('data-fit')).toBe(mode); }
  await k('i', 1500); await expect(page.locator('.banner.show')).toBeVisible();

  step('G guide, ↓ then Enter to tune, G to close');
  await k('g', 1200); await expect(page.locator('.overlay.guide')).toBeVisible();
  await k('ArrowDown', 600); await k('Enter', 1500); await k('g', 1000);
  await expect(page.locator('.overlay.guide')).toHaveCount(0);
  await watching();

  step('Space pause, , rewind, End back to live');
  await page.waitForTimeout(8000);
  // Never pause inside a channel bumper - wait for a program with time left on it.
  await page.waitForFunction(() => window.tv.state().then((st) => window.tv.tune(st.settings.lastChannel)).then((t) => !!t?.play && t.entry.end - Date.now() > 25000), null, { timeout: 90000, polling: 1000 });
  await k(' ', 2500); await expect(page.locator('.dvr')).toBeVisible();
  await k(' ', 400);
  await k(',', 300); await k(',', 300); await k(',', 1500);
  expect(await page.locator('.dvr-time').textContent()).toMatch(/^−/);
  await k('End', 1500);
  expect(await page.evaluate(() => document.querySelector('.dvr-time')?.textContent ?? 'LIVE')).toBe('LIVE');

  step('F fullscreen, Esc leaves');
  await k('f', 2000);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await k('Escape', 1500);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);

  step('S settings: arrows + Enter turn on single channel mode, Esc closes');
  await k('s', 1000);
  for (let i = 0; i < 25 && (await page.evaluate(() => document.querySelector('.gp-focus')?.tagName)) !== 'SELECT'; i++) await k('ArrowDown', 200);
  expect(await page.evaluate(() => document.querySelector('.gp-focus')?.tagName)).toBe('SELECT');
  await k('Enter', 400); await k('ArrowDown', 400); await k('Enter', 700);
  const locked = (await state()).settings.lockChannel;
  expect(locked).toBeTruthy();
  await k('Escape', 800);
  await k('ArrowUp', 1200);
  expect((await state()).settings.lastChannel).toBe(locked);
  await k('s', 800);
  for (let i = 0; i < 25 && (await page.evaluate(() => document.querySelector('.gp-focus')?.tagName)) !== 'SELECT'; i++) await k('ArrowDown', 200);
  await k('Enter', 400); await k('ArrowUp', 400); await k('Enter', 600);
  expect((await state()).settings.lockChannel).toBeFalsy();
  await k('Escape', 600);

  step('C / L panels with Esc back');
  await k('c', 1000); await expect(page.locator('.overlay h2')).toHaveText('Channels');
  await k('Escape', 500);
  await k('l', 1000); await expect(page.locator('.overlay h2')).toHaveText('Library');
  await k('Escape', 500);
  await expect(page.locator('.overlay:not(.ondemand)')).toHaveCount(0); // (an On Demand channel's wall can be up)
  step('keyboard tour done');
});

test('Settings shows a control map for keyboard, Xbox and PS5', async () => {
  await page.keyboard.press('s');
  const map = page.locator('.controls-map');
  await map.scrollIntoViewIfNeeded();
  for (const [tab, expectText, shot] of [['Keyboard', 'Backspace', 'keyboard'], ['Xbox controller', 'LB', 'xbox'], ['PS5 controller', 'L1', 'ps5']]) {
    await map.getByRole('button', { name: tab }).click();
    await expect(map).toContainText(expectText);
    await map.screenshot({ path: path.join(SHOTS, `controls-${shot}.png`), timeout: 8000 }).catch(() => {}); // a picture for reference, not a check
  }
  await expect(map.locator('.pad-ps-x').first()).toHaveText('✕');
  await page.keyboard.press('Escape');
  // The hints follow the last thing used: keyboard → keys…
  await page.keyboard.press('s');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.pad-legend.show')).toContainText('Enter');
  await expect(page.locator('.pad-legend.show kbd').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'legend-keyboard.png') });
  // …an Xbox pad → Xbox buttons…
  await page.evaluate(() => window.__padKindTest('xbox'));
  await page.evaluate(() => window.__gamepadPress('DOWN'));
  await expect(page.locator('.pad-legend.show .pad-a')).toHaveText('A');
  // …and the mouse puts them away.
  await page.mouse.click(5, 300);
  await expect(page.locator('.pad-legend.show')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // On a regular channel (the On Demand wall has its own, shorter legend).
  const reg = (await page.evaluate(() => window.tv.state())).channels.find((c) => !c.ondemand && !c.iptv);
  for (const d of String(reg.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  // A DualSense swaps the on-screen legend to PlayStation buttons.
  await page.evaluate(() => window.__padKindTest('ps'));
  await page.evaluate(() => window.__gamepadPress('DOWN'));
  await expect(page.locator('.pad-legend.show')).toContainText('L1');
  await expect(page.locator('.pad-legend .pad-ps-sq')).toHaveText('□');
  await page.screenshot({ path: path.join(SHOTS, 'controls-ps5-legend.png') });
  await page.evaluate(() => window.__gamepadPress('UP'));
});

test('funny commercial breaks (off by default, then on)', async () => {
  test.setTimeout(240000);
  expect((await page.evaluate(() => window.tv.state())).settings.adsOn).toBeFalsy();
  // A quick channel of one short clip, back-to-back, so a break comes up fast.
  const items = await page.evaluate(() => window.tv.items());
  const clip = items.filter((i) => i.kind === 'short').sort((a, b) => a.duration - b.duration)[0];
  await page.evaluate((c) => window.tv.createChannels([{ name: 'Ad Test', order: 'ordered', align: 0, sources: [{ type: 'item', id: c.id, label: c.title }] }]), clip);
  await page.keyboard.press('s');
  await page.locator('.ads-box .toggle').first().click();
  await expect(page.locator('.ads-box')).toContainText('Break length');
  await page.locator('.ads-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'ads-01-settings.png') });
  await page.keyboard.press('Escape');
  const ch = (await page.evaluate(() => window.tv.state())).channels.find((c) => c.name === 'Ad Test');
  await page.evaluate(() => window.tv.setSettings({ adSeconds: 45 }));
  for (const d of String(ch.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  // The ads are real videos now (the pack that ships with HomeCable) - wait for one to air.
  await expect.poll(async () => (await page.evaluate((id) => window.tv.tune(id), ch.id))?.entry?.type, { timeout: clip.duration * 1000 + 40000, intervals: [1000] }).toBe('ad');
  const airing = await page.evaluate((id) => window.tv.tune(id), ch.id);
  console.log('ad on air:', airing.entry.title);
  expect(airing.entry.title).toMatch(/^Ad [1-5]$/); // one of the shipped ads, not a joke card
  expect(airing.play).toBeTruthy();                 // it's a real video, not a drawn card
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SHOTS, 'ads-02-on-air.png') });
  await page.waitForTimeout(DWELL);
  // Turn them back off: no more breaks scheduled.
  await page.evaluate(() => window.tv.setSettings({ adsOn: false }));
  await expect.poll(async () => {
    const rows = await page.evaluate((f) => window.tv.guide(f, f + 3600e3), Date.now());
    return (rows.find((r) => r.id === ch.id)?.entries || []).filter((e) => e.type === 'ad' && e.start > Date.now()).length;
  }, { timeout: 60000, intervals: [2000] }).toBe(0);
});

test('free TV: classic cartoons + live IPTV stations', async () => {
  test.skip(!process.env.HOMECABLE_NET, 'set HOMECABLE_NET=1 (needs the internet)');
  test.setTimeout(400000);
  await page.evaluate(() => window.tv.freeAdd(['classic_cartoons'], 12));
  let s = await page.evaluate(() => window.tv.state());
  const cartoons = s.channels.find((c) => c.name === 'Classic Cartoons');
  expect(cartoons).toBeTruthy();
  for (const d of String(cartoons.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await watching();
  await page.screenshot({ path: path.join(SHOTS, 'free-01-cartoons.png') });
  await page.waitForTimeout(DWELL);
  await page.evaluate(() => window.tv.iptvAuto({ country: 'us', categories: ['news'], max: 3 }));
  await expect.poll(async () => (await page.evaluate(() => window.tv.state())).channels.filter((c) => c.iptv).length, { timeout: 300000, intervals: [3000] }).toBeGreaterThan(0);
  s = await page.evaluate(() => window.tv.state());
  const live = s.channels.find((c) => c.iptv);
  console.log('live station:', live.number, live.name);
  for (const d of String(live.number)) await page.keyboard.press(d);
  await page.keyboard.press('Enter');
  await watching();
  await page.screenshot({ path: path.join(SHOTS, 'free-02-live.png') });
  await page.waitForTimeout(DWELL);
  await page.keyboard.press('g');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOTS, 'free-03-guide.png') });
  await page.keyboard.press('g');
});

test('arcade: every game starts, plays and quits back to TV', async () => {
  test.setTimeout(180000);
  await page.keyboard.press('a');
  await expect(page.locator('.arcade-card')).toHaveCount(4);
  await page.screenshot({ path: path.join(SHOTS, 'arcade-01-menu.png') });
  const names = await page.locator('.arcade-card b').allTextContents();
  for (const [i, name] of names.entries()) {
    await page.locator('.arcade-card').nth(i).click();
    await expect(page.locator('.game-screen canvas')).toBeVisible();
    // Play a little: hold right + fire / jump.
    await page.keyboard.down('ArrowRight');
    for (let n = 0; n < 6; n++) { await page.keyboard.press('Space'); await page.waitForTimeout(250); }
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('ArrowUp'); await page.waitForTimeout(300); await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(DWELL / 2);
    // The canvas is drawing (not blank).
    const lit = await page.evaluate(() => { const c = document.querySelector('.game-screen canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 16) if (d[k] + d[k + 1] + d[k + 2] > 60) n++; return n; });
    expect(lit, name + ' draws').toBeGreaterThan(50);
    await page.screenshot({ path: path.join(SHOTS, `arcade-${i + 2}-${name.replace(/\W+/g, '-').toLowerCase()}.png`) });
    await page.keyboard.press('Escape'); // leaves the game, back to the arcade menu
    await expect(page.locator('.arcade-card')).toHaveCount(4);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.overlay:not(.ondemand)')).toHaveCount(0); // (an On Demand channel's wall can be up)
});
