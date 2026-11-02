// Xbox / PlayStation controllers as the TV remote (Gamepad API, "standard"
// mapping — Xbox over Bluetooth/USB and DualSense/DualShock both report it).
//
// Contexts, each with its own layout and an on-screen legend:
//   tv       watching: bumpers/triggers = channels, D-pad = volume/brightness
//   guide    D-pad moves through the grid, A watches
//   menu     panels & dialogs: D-pad moves a focus ring, A selects
//   adjust   a number/time/slider/dropdown is grabbed: D-pad changes its value
//   keyboard on-screen keyboard for text fields
// Actions reach the app as keyboard events, so keyboard and pad share one path.

import { PAD_NAMES, FACE_CLASS, padKindFromId } from './controls.js';

const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const HOLD_CAST = 700;
const REPEAT_DELAY = 420, REPEAT_RATE = 110, CHANNEL_REPEAT = 380;
const DIRS = { [B.UP]: 'up', [B.DOWN]: 'down', [B.LEFT]: 'left', [B.RIGHT]: 'right' };
const FOCUSABLE = 'button:not([disabled]), input:not([type=hidden]), select, .pick-item, .sug, .ch-card .icon-btn, .show';

function key(k) {
  const a = document.activeElement;
  const target = a && a !== document.body && !a.matches('input, textarea, select') ? a : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

const visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && !el.closest('.hide');
};

// Which layer owns the controller right now?
function layer() {
  return document.querySelector('.modal-bg') || document.querySelector('.setup') ||
    document.querySelector('.overlay:not(.guide)') || null;
}

function focusables(root) {
  // Panels also reach the top bar (to switch panels / go back to TV).
  const scopes = root.classList.contains('overlay') ? [root, document.querySelector('.topbar')] : [root];
  return scopes.filter(Boolean).flatMap((s) => [...s.querySelectorAll(FOCUSABLE)])
    .filter((el) => visible(el) && !(el.matches('.pick-item') && el.closest('.sug')) && !el.matches('.sug .box'));
}

// ---------- focus ring ----------
let current = null;
function setFocus(el) {
  current?.classList.remove('gp-focus');
  current = el;
  if (!el) return;
  el.classList.add('gp-focus');
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function move(dir) {
  const root = layer();
  if (!root) return;
  const list = focusables(root);
  if (!list.length) return;
  if (!current || !document.contains(current) || !list.includes(current)) {
    // Start on the panel's primary action, else its first control (not the top bar).
    const inPanel = list.filter((el) => root.contains(el));
    setFocus(root.querySelector('.gp-default:not([disabled])') || root.querySelector('.btn.primary:not([disabled])') || inPanel[0] || list[0]);
    return;
  }
  const c = current.getBoundingClientRect();
  const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  // Like a TV menu: Up/Down go to the nearest row in that direction, then the
  // control in that row closest to you (edge to edge, so a wide dropdown lined
  // up with a small toggle counts as straight below it). Left/Right stay in the row.
  const vertical = dir === 'up' || dir === 'down';
  const cands = [];
  for (const el of list) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    let main;
    if (dir === 'up') main = c.top - r.bottom;
    else if (dir === 'down') main = r.top - c.bottom;
    else if (dir === 'left') main = c.left - r.right;
    else main = r.left - c.right;
    // Must actually be in that direction (small overlaps allowed for ragged rows).
    const ahead = dir === 'up' ? r.top + r.height / 2 < cy - 2 : dir === 'down' ? r.top + r.height / 2 > cy + 2 : dir === 'left' ? r.left + r.width / 2 < cx - 2 : r.left + r.width / 2 > cx + 2;
    if (!ahead) continue;
    const gapX = Math.max(0, r.left - c.right, c.left - r.right);
    const gapY = Math.max(0, r.top - c.bottom, c.top - r.bottom);
    // left/right: same row only — the two must share most of their height.
    if (!vertical && Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) < Math.min(r.height, c.height) * 0.5) continue;
    cands.push({ el, main: Math.max(0, main), side: vertical ? gapX : gapY, center: vertical ? Math.abs(r.left + r.width / 2 - cx) : Math.abs(r.top + r.height / 2 - cy) });
  }
  let best = null;
  if (cands.length) {
    const nearest = Math.min(...cands.map((k) => k.main));
    const row = cands.filter((k) => k.main <= nearest + (vertical ? 14 : 4));
    row.sort((a, b2) => a.side - b2.side || a.center - b2.center);
    best = row[0].el;
  }
  if (best) setFocus(best);
}

// Set an input's value the way a user would, so Preact's onInput sees it.
function setValue(el, v) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

// ---------- adjust mode (number / time / range / select) ----------
let adjusting = null;
const ADJUSTABLE = 'input[type=number], input[type=time], input[type=range], select';
function adjust(el, d) {
  if (el.matches('select')) {
    const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + d));
    setValue(el, el.options[i].value);
  } else if (el.type === 'time') {
    const [h, m] = (el.value || '00:00').split(':').map(Number);
    let t = (h * 60 + m + d * 15 + 1440) % 1440;
    t -= t % 15;
    setValue(el, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  } else {
    const step = +el.step || 1, min = el.min !== '' ? +el.min : -Infinity, max = el.max !== '' ? +el.max : Infinity;
    const v = Math.max(min, Math.min(max, Math.round(((+el.value || 0) + d * step) / step) * step));
    setValue(el, String(+v.toFixed(4)));
  }
}

// ---------- on-screen keyboard ----------
const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl\'', 'zxcvbnm,.-', ['Shift', 'Space', '⌫', 'Done']];
let osk = null; // { el, input, row, col, shift }
function openKeyboard(input) {
  const el = document.createElement('div');
  el.className = 'osk';
  document.body.appendChild(el);
  osk = { el, input, row: 1, col: 0, shift: false };
  renderKeyboard();
}
function closeKeyboard() { osk?.el.remove(); osk = null; }
function oskKeys(r) { return Array.isArray(ROWS[r]) ? ROWS[r] : [...ROWS[r]]; }
function renderKeyboard() {
  const { el, input, row, col, shift } = osk;
  const label = input.closest('label')?.childNodes[0]?.textContent || input.placeholder || 'Type';
  el.innerHTML = `<div class="osk-title">${label.replace(/</g, '&lt;')}</div><div class="osk-value"></div>` +
    ROWS.map((_, r) => `<div class="osk-row">${oskKeys(r).map((k, c) => {
      const t = k.length === 1 && shift ? k.toUpperCase() : k;
      return `<span class="osk-key${k.length > 1 ? ' wide' : ''}${r === row && c === col ? ' on' : ''}${k === 'Shift' && shift ? ' lit' : ''}">${t.replace(/</g, '&lt;')}</span>`;
    }).join('')}</div>`).join('') +
    '<div class="osk-hint">A type · X delete · Y space · LB/RB move cursor · Menu or B done</div>';
  el.querySelector('.osk-value').textContent = input.value + '▏';
}
function oskAct(btn) {
  const k = oskKeys(osk.row)[osk.col];
  const type = (s) => setValue(osk.input, osk.input.value + s);
  if (DIRS[btn]) {
    const d = DIRS[btn];
    if (d === 'up' || d === 'down') {
      const frac = (osk.col + 0.5) / oskKeys(osk.row).length;
      osk.row = (osk.row + (d === 'down' ? 1 : -1) + ROWS.length) % ROWS.length;
      osk.col = Math.min(oskKeys(osk.row).length - 1, Math.floor(frac * oskKeys(osk.row).length));
    } else {
      const n = oskKeys(osk.row).length;
      osk.col = (osk.col + (d === 'right' ? 1 : -1) + n) % n;
    }
  } else if (btn === B.A) {
    if (k === 'Shift') osk.shift = !osk.shift;
    else if (k === 'Space') type(' ');
    else if (k === '⌫') setValue(osk.input, osk.input.value.slice(0, -1));
    else if (k === 'Done') return closeKeyboard();
    else { type(osk.shift ? k.toUpperCase() : k); osk.shift = false; }
  } else if (btn === B.X) setValue(osk.input, osk.input.value.slice(0, -1));
  else if (btn === B.Y) type(' ');
  else if (btn === B.B || btn === B.MENU || btn === B.VIEW) return closeKeyboard();
  else return;
  renderKeyboard();
}

// ---------- the legend ----------
const LEGENDS = {
  tv: [['LB', 'RB', 'Channel'], ['LT', 'RT', 'Rewind / FF'], ['X', 'Pause'], ['B', 'Mute'], ['↑', '↓', 'Volume'], ['←', '→', 'Brightness'], ['≡', 'Guide'], ['A', 'Info'], ['Y', 'Menu'], ['⧉', 'Fullscreen · hold: Cast']],
  tvLocked: [['LT', 'RT', 'Rewind / FF'], ['X', 'Pause'], ['B', 'Mute'], ['↑', '↓', 'Volume'], ['←', '→', 'Brightness'], ['≡', 'Schedule'], ['A', 'Info'], ['Y', 'Menu'], ['⧉', 'Fullscreen']],
  guide: [['✥', 'Browse'], ['A', 'Watch'], ['X', 'Mix into a channel'], ['LB', 'RB', 'Page'], ['B', 'Close'], ['Y', 'Menu']],
  menu: [['✥', 'Move'], ['A', 'Select'], ['B', 'Back'], ['LB', 'RB', 'Tabs'], ['R', 'Scroll'], ['≡', 'Back to TV']],
  adjust: [['↑', '↓', 'Change'], ['←', '→', 'Change'], ['A', 'B', 'Done']],
  keyboard: [],
  vod: [['LT', 'RT', 'Rewind / FF'], ['X', 'Pause'], ['RB', 'Next episode'], ['LB', 'Audio & subs'], ['A', 'Info · Skip'], ['B', 'Back'], ['⧉', 'Fullscreen']],
  ondemand: [['✥', 'Browse'], ['A', 'Watch'], ['LB', 'RB', 'Channel'], ['≡', 'Guide'], ['Y', 'Menu'], ['⧉', 'Fullscreen · hold: Cast']],
};
// The same hints for keyboard users.
const KEY_LEGENDS = {
  tv: [['↑', '↓', 'Channel'], [',', '.', 'Rewind / FF'], ['Space', 'Pause'], ['M', 'Mute'], ['←', '→', 'Volume'], ['[', ']', 'Brightness'], ['G', 'Guide'], ['I', 'Info'], ['S', 'Settings'], ['F', 'Fullscreen'], ['K', 'Cast']],
  tvLocked: [[',', '.', 'Rewind / FF'], ['Space', 'Pause'], ['M', 'Mute'], ['←', '→', 'Volume'], ['[', ']', 'Brightness'], ['G', 'Schedule'], ['I', 'Info'], ['S', 'Settings'], ['F', 'Fullscreen']],
  guide: [['↑', '↓', '←', '→', 'Browse'], ['Enter', 'Watch'], ['M', 'Mix into a channel'], ['PgUp', 'PgDn', 'Page'], ['G', 'Close']],
  menu: [['↑', '↓', '←', '→', 'Move'], ['Enter', 'Select'], ['Esc', 'Back'], ['C', 'L', 'A', 'S', 'Tabs']],
  adjust: [['↑', '↓', 'Change'], ['Enter', 'Done']],
  keyboard: [],
  vod: [[',', '.', 'Rewind / FF'], ['Space', 'Pause'], ['←', '→', 'Volume'], ['N', 'Next ep'], ['V', 'Audio & subs'], ['I', 'Info'], ['Esc', 'Back'], ['F', 'Fullscreen']],
  ondemand: [['↑', '↓', '←', '→', 'Browse'], ['Enter', 'Watch'], ['PgUp', 'PgDn', 'Channel'], ['G', 'Guide'], ['S', 'Settings'], ['K', 'Cast']],
};
// Legend tokens → standard button names (so PS5 gets ✕ ○ □ △ / L1 R1 / Options).
const TOKEN = { '≡': 'MENU', '⧉': 'VIEW', L3: 'LS', R3: 'RS', R: 'RSTICK' };
// The hints follow whatever you used last: Xbox pad, PS5 pad, or keyboard.
// Using the mouse puts them away.
let legendEl = null, legendCtx = '', lastInput = -Infinity;
let padKind = 'xbox';      // brand of the last controller
let device = 'keyboard';   // 'xbox' | 'ps' | 'keyboard' — whatever was used last
function setDevice(kind) {
  if (kind === device && window.__inputKind) return;
  device = kind;
  window.__inputKind = kind;
  legendCtx = '';
  window.dispatchEvent(new CustomEvent('padkind', { detail: kind }));
}
function setPadKind(kind) {
  padKind = kind;
  window.__padKind = kind;
  setDevice(kind);
}
function context() {
  if (osk) return 'keyboard';
  if (adjusting) return 'adjust';
  if (layer()?.classList.contains('ondemand')) return 'ondemand';
  if (layer()) return 'menu';
  if (document.querySelector('.overlay.guide')) return 'guide';
  if (document.querySelector('.stage[data-vod]')) return 'vod';
  return document.querySelector('.lock-badge') ? 'tvLocked' : 'tv';
}
function renderLegend() {
  if (!legendEl) { legendEl = document.createElement('div'); legendEl.className = 'pad-legend'; document.body.appendChild(legendEl); }
  const ctx = context();
  // Menus and the guide keep the hints up; on the TV they fade after a few seconds.
  const used = lastInput > -Infinity;
  const show = used && (/^(menu|guide|adjust)$/.test(ctx) || performance.now() - lastInput < 6000);
  legendEl.classList.toggle('show', show && ctx !== 'keyboard' && !document.body.classList.contains('in-game'));
  document.body.classList.toggle('legend-up', legendEl.classList.contains('show')); // lifts toasts above it
  document.body.classList.toggle('pad-active', show);
  legendEl.dataset.device = device;
  const key = ctx + '|' + device;
  if (key === legendCtx) return;
  legendCtx = key;
  const kb = device === 'keyboard';
  legendEl.innerHTML = (kb ? KEY_LEGENDS : LEGENDS)[ctx].map((item) => {
    const label = item[item.length - 1];
    const keys = item.slice(0, -1).map((k) => {
      if (kb) return `<kbd>${k}</kbd>`;
      const name = TOKEN[k] || k;
      const text = PAD_NAMES[padKind][name] && name !== 'RSTICK' ? PAD_NAMES[padKind][name] : k;
      return `<span class="pad-hint ${FACE_CLASS[padKind][name] || 'pad-n'}">${text}</span>`;
    }).join('');
    return `<span class="pad-item">${keys}<span>${label}</span></span>`;
  }).join('');
}

// ---------- dispatch ----------
function cycleTab(d) {
  // The app says which screens a controller cycles through (the Edit menu's
  // screens included), so the dropdown never traps the shoulder buttons.
  const oc = window.__overlayCycle;
  if (oc) {
    const list = oc.list();
    if (!list.length) return;
    const i = list.indexOf(oc.current());
    oc.open(list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length]);
    setFocus(null);
    return;
  }
  const tabs = [...document.querySelectorAll('.topbar .nav button')].filter((t) => !t.textContent.includes('Guide'));
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.classList.contains('on'));
  tabs[(i + d + tabs.length) % tabs.length].click();
  setFocus(null);
}

function release() { adjusting?.classList.remove('gp-adjust'); adjusting = null; }

function act(btn) {
  if (osk) { if (!document.contains(osk.input)) closeKeyboard(); else return oskAct(btn); }
  if (adjusting) {
    if (!document.contains(adjusting)) release();
    else {
      if (btn === B.UP || btn === B.RIGHT) adjust(adjusting, adjusting.matches('select') && btn === B.UP ? -1 : 1);
      else if (btn === B.DOWN || btn === B.LEFT) adjust(adjusting, adjusting.matches('select') && btn === B.DOWN ? 1 : -1);
      else if (btn === B.A || btn === B.B || btn === B.MENU) release();
      return;
    }
  }
  const menu = layer();
  // On Demand poster wall: it's still the TV — bumpers flip channels, Menu opens the guide.
  if (menu?.classList.contains('ondemand')) {
    if (btn === B.LB || btn === B.LT) return key('PageDown');
    if (btn === B.RB || btn === B.RT) return key('PageUp');
    if (btn === B.MENU) { setFocus(null); return key('g'); }
    if (btn === B.Y) { setFocus(null); return key('s'); }
    if (btn === B.B) return key('Escape'); // e.g. back from a show's episode list
  }
  if (menu) {
    if (DIRS[btn]) return move(DIRS[btn]);
    switch (btn) {
      case B.A: {
        if (!current || !document.contains(current)) return move('down');
        const el = current;
        if (el.matches(ADJUSTABLE)) { adjusting = el; el.classList.add('gp-adjust'); return; }
        if (el.matches('input')) { openKeyboard(el); return; }
        el.click();
        // Clicks often re-render the panel; keep the ring on something sensible.
        requestAnimationFrame(() => { if (current && !document.contains(current)) setFocus(null); });
        return;
      }
      case B.B: setFocus(null); return key('Escape');
      case B.X: if (current?.matches?.('input')) { setValue(current, ''); } return;
      case B.LB: case B.LT: return cycleTab(-1);
      case B.RB: case B.RT: return cycleTab(1);
      case B.MENU: case B.Y: setFocus(null); return key('BackToTV');
      case B.VIEW: return key('f');
    }
    return;
  }
  setFocus(null);
  if (document.querySelector('.overlay.guide')) {
    switch (btn) {
      case B.UP: return key('ArrowUp');
      case B.DOWN: return key('ArrowDown');
      case B.LEFT: return key('ArrowLeft');
      case B.RIGHT: return key('ArrowRight');
      case B.A: return key('Enter');
      case B.X: return key('MixLive');
      case B.B: case B.MENU: return key('g');
      case B.LB: case B.LT: return key('PageUp');
      case B.RB: case B.RT: return key('PageDown');
      case B.Y: return key('s');
      case B.VIEW: return key('f');
    }
    return;
  }
  // Watching TV (or on demand: same buttons, but B goes back to the library).
  if (btn === B.B && document.querySelector('.stage[data-vod]')) return key('Escape');
  if (btn === B.A && document.querySelector('.skip-btn')) return document.querySelector('.skip-btn').click();
  if (btn === B.RB && document.querySelector('.stage[data-vod]')) return key('n');
  if (btn === B.LB && document.querySelector('.stage[data-vod]')) return key('v');
  switch (btn) {
    case B.UP: return key('AudioVolumeUp');
    case B.DOWN: return key('AudioVolumeDown');
    case B.LEFT: return key('BrightnessDown');
    case B.RIGHT: return key('BrightnessUp');
    case B.LB: return key('ChannelDown');
    case B.RB: return key('ChannelUp');
    case B.LT: return key('MediaRewind');
    case B.RT: return key('MediaFastForward');
    case B.MENU: return key('g');
    case B.A: return key('i');
    case B.B: return key('m'); // one-button mute / unmute
    case B.X: return key(' ');
    case B.Y: return key('s');
    case B.VIEW: return key('f');
    case B.LS: return key('Backspace');
    case B.RS: return key('z');
  }
}

// A button pressed somewhere else (the phone app's remote): exactly like the controller.
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
export function pressButton(name) { if (name in BTN) document.dispatchEvent(new CustomEvent('gp-test', { detail: BTN[name] })); }

// Put the highlight on the open screen's default spot (as if an arrow was pressed).
export function focusDefault() { const r = layer(); if (r && !(current && r.contains(current))) move('down'); }

export function startGamepad({ onActivity, onConnect }) {
  const held = new Map(); // button index -> { since, last }
  let raf;
  addEventListener('gamepadconnected', (e) => { setPadKind(padKindFromId(e.gamepad.id)); onConnect?.(e.gamepad.id, true); });
  // Keyboard in menus: arrows move the same highlight the controller uses,
  // Enter presses it — so rows that aren't real buttons are reachable too.
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || !layer() || osk) return;
    if (adjusting) {
      const b = { ArrowUp: B.UP, ArrowDown: B.DOWN, ArrowLeft: B.LEFT, ArrowRight: B.RIGHT, Enter: B.A, Escape: B.B, ' ': B.A }[e.key];
      if (b != null) { e.preventDefault(); e.stopPropagation(); act(b); renderLegend(); }
      return;
    }
    const typing = e.target.closest?.('input, textarea, select');
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (dir && !typing) { e.preventDefault(); e.stopPropagation(); move(dir); return; }
    // While a channel number is being typed (e.g. "2" on the On Demand wall), Enter finishes the number.
    if (e.key === 'Enter' && document.querySelector('.number-entry')) return;
    if ((e.key === 'Enter' || e.key === ' ') && !typing && current && document.contains(current) && document.activeElement !== current) {
      e.preventDefault(); e.stopPropagation(); act(B.A); renderLegend();
    }
  }, true);
  addEventListener('gamepaddisconnected', (e) => onConnect?.(e.gamepad.id, false));
  // The mouse takes over again as soon as it's used.
  addEventListener('mousedown', () => { setFocus(null); release(); closeKeyboard(); lastInput = -Infinity; renderLegend(); }, true);
  // Keyboard counts as "last used" too (real key presses only; not our own synthetic ones).
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.target.closest?.('input, textarea')) return;
    setDevice('keyboard');
    lastInput = performance.now();
    renderLegend();
  }, true);
  const NAME = Object.fromEntries(Object.entries(B).map(([k, v]) => [v, k]));
  const run = (btn) => {
    lastInput = performance.now(); setDevice(padKind); onActivity?.();
    // Entering a controller combo (profile lock): the buttons are the code, not commands.
    if (window.__padCapture) { window.__padCapture(NAME[btn]); return; }
    act(btn); renderLegend();
  };
  document.addEventListener('gp-test', (e) => run(e.detail));

  const repeats = new Set([B.UP, B.DOWN, B.LEFT, B.RIGHT, B.LB, B.RB, B.LT, B.RT, B.X]);
  const channelBtns = new Set([B.LB, B.RB, B.LT, B.RT]);

  const loop = () => {
    const now = performance.now();
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const pressed = new Set();
    let scroll = 0;
    for (const gp of pads) {
      if (gp.buttons.some((b) => b.pressed)) setPadKind(padKindFromId(gp.id));
      // Triggers are analog: need a firm squeeze so a resting finger doesn't flip channels.
      gp.buttons.forEach((b, i) => { if (i === B.LT || i === B.RT ? b.value > 0.6 : b.pressed) pressed.add(i); });
      const [x = 0, y = 0, , ry = 0] = gp.axes;
      // Left stick doubles as the D-pad.
      if (y < -0.6) pressed.add(B.UP); if (y > 0.6) pressed.add(B.DOWN);
      if (x < -0.6) pressed.add(B.LEFT); if (x > 0.6) pressed.add(B.RIGHT);
      if (Math.abs(ry) > 0.25) scroll = ry;
    }
    // Right stick scrolls whatever menu is open.
    if (scroll && layer()) {
      const box = layer().querySelector('.overlay-body, .modal-body, .setup-card, .pick-list');
      box?.scrollBy(0, scroll * 18);
      lastInput = now;
    }
    const gaming = document.body.classList.contains('in-game');
    for (const i of pressed) {
      const h = held.get(i);
      if (gaming) { if (!h) held.set(i, { since: now, last: now }); continue; } // the game reads the pad itself
      // View: tap = fullscreen, hold = cast to a TV (decided on release / after the hold).
      if (i === B.VIEW && !window.__padCapture) {
        if (!h) held.set(i, { since: now, last: now });
        else if (!h.fired && now - h.since > HOLD_CAST) { h.fired = true; lastInput = now; setDevice(padKind); onActivity?.(); key('k'); renderLegend(); }
        continue;
      }
      if (!h) { held.set(i, { since: now, last: now }); run(i); }
      else if (repeats.has(i) && now - h.since > REPEAT_DELAY && now - h.last > (channelBtns.has(i) && context().startsWith('tv') ? (i === B.LT || i === B.RT ? 160 : CHANNEL_REPEAT) : REPEAT_RATE)) { h.last = now; run(i); }
    }
    for (const i of [...held.keys()]) {
      if (pressed.has(i)) continue;
      const h = held.get(i);
      held.delete(i);
      if (i === B.VIEW && !gaming && !h.fired && !window.__padCapture) run(B.VIEW);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  const legendTimer = setInterval(renderLegend, 500);
  return () => { cancelAnimationFrame(raf); clearInterval(legendTimer); };
}

// Test hook: lets e2e tests drive the controller logic without hardware.
window.__padKindTest = (kind) => (kind === 'keyboard' ? setDevice('keyboard') : setPadKind(kind));
window.__gamepadHoldView = () => key('k');
window.__gamepadPress = (name) => { const i = B[name]; if (i != null) document.dispatchEvent(new CustomEvent('gp-test', { detail: i })); };
export const BUTTONS = B;
