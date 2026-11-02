// Channel bumpers (station idents): a few seconds of the channel's own logo
// between shows, like the network bumps on real cable. Six little animations,
// all drawn live from the channel's look (font, shape, colors) — no video files.
import { html } from 'htm/preact';
import { lookStyle, LOOK_FONTS } from './util.js';

// What each variant does lives in styles.css (.ident.v0 … .v5).
const KICKERS = ['You’re watching', 'This is', 'Only on', 'You’re watching', 'Stay tuned to', 'More ahead on'];

export function IdentCard({ channel, entry }) {
  const { f, c1, c2, text, shape } = lookStyle(channel, 200);
  const v = Math.max(0, Math.min(5, entry?.variant ?? 0));
  const name = channel?.name || '';
  const badge = channel?.look?.custom
    ? html`<div class="ident-badge img"><img src=${channel.look.custom} alt="" /></div>`
    : channel?.look
      ? html`<div class=${'ident-badge s-' + shape} style=${`--f:${f.css};--w:${f.weight};--sp:${f.spacing};--c1:${c1};--c2:${c2}`}>${text}</div>`
      : html`<div class="ident-badge" style=${`--f:${LOOK_FONTS.modern.css};--w:800;--sp:.06em;--c1:${channel?.color || '#6c8cff'};--c2:#14161f`}>${channel?.logo || (name || '?').slice(0, 2).toUpperCase()}</div>`;
  return html`<div class=${'ident v' + v} key=${entry?.start} style=${`--c1:${c1};--c2:${c2};--f:${f.css};--w:${f.weight};--sp:${f.spacing}`}>
    <div class="ident-bg"></div>
    <div class="ident-inner">
      <div class="ident-kicker">${KICKERS[v]}</div>
      ${badge}
      <div class="ident-name">${name}</div>
    </div>
  </div>`;
}
