// The one control map. Settings, the help popup and the on-screen controller
// legend all read from here, so they can't drift apart.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';

// Controller button names per brand (standard Gamepad API layout).
export const PAD_NAMES = {
  xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', VIEW: 'View', MENU: 'Menu', LS: 'L3', RS: 'R3', DPAD: 'D-pad', RSTICK: 'Right stick' },
  ps: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', VIEW: 'Create', MENU: 'Options', LS: 'L3', RS: 'R3', DPAD: 'D-pad', RSTICK: 'Right stick' },
};
// Face-button colors: Xbox A green / B red / X blue / Y yellow; PlayStation ✕ blue / ○ red / □ pink / △ green.
export const FACE_CLASS = {
  xbox: { A: 'pad-a', B: 'pad-b', X: 'pad-x', Y: 'pad-y' },
  ps: { A: 'pad-ps-x', B: 'pad-ps-o', X: 'pad-ps-sq', Y: 'pad-ps-tri' },
};

export function padKindFromId(id = '') {
  // Sony's USB vendor id is 054c; DualSense/DualShock names also say so.
  return /054c|dualsense|dualshock|playstation|wireless controller \(/i.test(id) && !/xbox|xinput|045e/i.test(id) ? 'ps' : 'xbox';
}

// [what it does, keyboard keys, controller buttons (by standard name)]
export const CONTROL_MAP = [
  ['Watching TV', [
    ['Channel up / down', ['↑', '↓'], ['RB', 'LB'], 'also PgUp / PgDn or the mouse wheel'],
    ['Go to a channel number', ['0–9'], null, 'type the number — Enter to go right away'],
    ['Previous channel', ['Backspace'], ['LS']],
    ['Pause / resume', ['Space'], ['X']],
    ['Rewind / fast-forward 10 s', [',', '.'], ['LT', 'RT'], 'hold to scrub · back as far as you’ve watched this channel, up to live'],
    ['Back to live', ['End'], ['RT'], 'controller: keep fast-forwarding'],
    ['Mute / unmute', ['M'], ['B']],
    ['Volume down / up', ['←', '→'], ['DPAD'], 'D-pad down / up'],
    ['Brightness down / up', ['[', ']'], ['DPAD'], 'D-pad left / right'],
    ['What’s on (info banner)', ['I'], ['A']],
    ['Next episode (on demand)', ['N'], ['RB'], 'or the ⏭ button; near the end a “Next episode” button pops up'],
    ['Skip intro', ['click'], ['A'], 'when “Skip intro” is on screen (uses the opening chapter, or skips 1:30)'],
    ['Pop-out mini player (always on top)', ['P'], null, 'a small resizable window that floats over your work; P or double-click brings it back'],
    ['Audio & subtitles (dub / sub)', ['V'], ['LB'], 'also the CC button — LB while watching on demand'],
    ['Subtitles: next track / off', ['T'], null, 'Auto turns them on for foreign-language audio'],
    ['Program guide', ['G'], ['MENU']],
    ['Menus (Channels · Library · Settings)', ['C', 'L', 'S'], ['Y']],
    ['HCtorrents (search, yours, engines)', ['click HCtorrents'], ['LB', 'RB']],
    ['Arcade (retro games)', ['A'], null, 'controller: Y, then RB to the Arcade tab'],
    ['Fullscreen on / off', ['F'], ['VIEW'], 'keyboard: also F11 or double-click · Esc leaves'],
    ['Picture size: Fit / Fill / Stretch', ['Z'], ['RS']],
    ['Cast to a TV (Chromecast / Google TV)', ['K'], ['VIEW'], 'controller: hold View for a moment (a quick tap is fullscreen)'],
    ['Help', ['?'], null],
  ]],
  ['Arcade games', [
    ['Move / steer', ['←', '→', '↑', '↓'], ['DPAD']],
    ['Fire / jump / launch', ['Space'], ['A']],
    ['Pause', ['P'], ['MENU']],
    ['Leave the game', ['Esc'], ['B']],
  ]],
  ['Guide', [
    ['Move around', ['↑', '↓', '←', '→'], ['DPAD']],
    ['Watch the highlighted channel', ['Enter'], ['A']],
    ['Mix a live show into one of your channels', ['M'], ['X']],
    ['Page up / down', ['PgUp', 'PgDn'], ['LB', 'RB']],
    ['Close the guide', ['G', 'Esc'], ['MENU', 'B']],
  ]],
  ['Menus & dialogs', [
    ['Move around', ['Tab', 'Shift+Tab'], ['DPAD'], 'controller: a highlight shows where you are'],
    ['Select / press', ['Enter', 'Space'], ['A']],
    ['Back / close', ['Esc'], ['B']],
    ['Switch tabs', ['C', 'L', 'S'], ['LB', 'RB']],
    ['Scroll', ['Mouse wheel'], ['RSTICK']],
    ['Type text', ['Keyboard'], ['A'], 'controller: A on a text box opens an on-screen keyboard'],
    ['Change a number, time or dropdown', ['↑', '↓'], ['A', 'DPAD'], 'controller: A grabs it, D-pad changes it, A lets go'],
    ['Straight back to TV', ['Esc'], ['MENU']],
  ]],
];

const Key = ({ k }) => html`<kbd>${k}</kbd>`;
export function PadButton({ name, kind }) {
  const label = PAD_NAMES[kind][name] || name;
  const face = FACE_CLASS[kind][name];
  return face ? html`<span class=${'pad-hint ' + face}>${label}</span>` : html`<kbd>${label}</kbd>`;
}

// Settings → Controls: one tab per device.
export function ControlsMap({ initial }) {
  const hide = (row) => row[0].startsWith('HCtorrents') && !window.__torrentsOn;
  // Opens on whatever you used last (keyboard, Xbox or PS5) and follows along.
  const [tab, setTab] = useState(initial || window.__inputKind || 'keyboard');
  useEffect(() => {
    const on = (e) => setTab(e.detail);
    window.addEventListener('padkind', on);
    return () => window.removeEventListener('padkind', on);
  }, []);
  return html`<div class="controls-map">
    <div class="seg" style="margin-bottom:16px">
      ${[['keyboard', '⌨  Keyboard'], ['xbox', 'Xbox controller'], ['ps', 'PS5 controller']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${CONTROL_MAP.map(([section, rows]) => html`
      <div class="section-title" style="margin-top:14px">${section}</div>
      <div class="help-grid">${rows.filter((r) => !hide(r) && (tab === 'keyboard' ? r[1] : r[2])).map(([what, keys, pad, note]) => html`
        <div class="row" style="gap:4px;flex-wrap:wrap">${tab === 'keyboard' ? keys.map((k) => html`<${Key} k=${k} />`) : pad.map((b) => html`<${PadButton} name=${b} kind=${tab} />`)}</div>
        <span><span>${what}</span>${note && html`<span class="faint small"> — ${note}</span>`}</span>`)}
      </div>`)}
    ${tab !== 'keyboard' && html`<p class="faint small" style="margin-top:16px">Pair the controller with Windows (Settings → Bluetooth & devices), then press any button. Xbox and PS5 (DualSense) controllers work over Bluetooth or USB. When a controller is in use, a strip at the bottom of the screen shows what each button does right now.</p>`}
  </div>`;
}
