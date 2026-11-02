import { html } from 'htm/preact';

export const tv = window.tv;

export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fmtDur = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
};
export const fmtClock = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
export const epLabel = (e) => {
  if (!e) return '';
  if (e.season != null && e.episode != null) return `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
  return '';
};
// Main line + sub line for a schedule entry.
export function entryText(e) {
  if (!e) return { title: 'No signal', sub: '' };
  if (e.type === 'upnext') return { title: 'Up Next', sub: '' };
  if (e.type === 'ondemand') return { title: 'On Demand', sub: e.sub || 'Pick a movie' };
  if (e.type === 'offair') return { title: e.title || 'Off Air', sub: '' };
  if (e.type === 'filler') return { title: e.title, sub: 'Break' };
  if (e.type === 'ad') return { title: 'Commercial break', sub: e.title };
  if (e.type === 'ident') return { title: e.title || 'Station break', sub: 'We’ll be right back' };
  if (e.type === 'live' && !e.live) return { title: e.title || 'Live', sub: 'Live' };
  if (e.live) return { title: e.title, sub: e.sub || 'Live' };
  if (e.show) return { title: e.show, sub: [epLabel(e), e.title].filter(Boolean).join(' · ') };
  return { title: e.title, sub: e.kind === 'movie' ? 'Movie' : e.kind === 'music' ? 'Music' : '' };
}

export const ORDER_LABEL = { sequential: 'Episodes in order, shows rotate', shuffle: 'Shuffle everything (no repeats until all played)', random: 'Fully random — anything, any time', ordered: 'Play the list in order' };
export const PALETTE = ['#ff5a5f', '#ffb400', '#00a699', '#7b61ff', '#2d9cdb', '#f2994a', '#eb5757', '#27ae60', '#bb6bd9', '#56ccf2', '#e0558a', '#6fcf97'];

// ---------- The channel's network look (its made logo) ----------
export const LOOK_FONTS = {
  impact: { label: 'Bold', css: "'Impact', 'Arial Black', sans-serif", weight: 400, spacing: '0.02em' },
  modern: { label: 'Modern', css: "'Bahnschrift', 'Segoe UI Variable Display', 'Segoe UI', sans-serif", weight: 700, spacing: '0.08em' },
  classic: { label: 'Classic', css: "Georgia, 'Times New Roman', serif", weight: 700, spacing: '0.01em' },
  script: { label: 'Script', css: "'Segoe Script', 'Comic Sans MS', cursive", weight: 700, spacing: '0' },
  fun: { label: 'Fun', css: "'Comic Sans MS', 'Segoe Print', cursive", weight: 700, spacing: '0' },
  tech: { label: 'Tech', css: "Consolas, 'Courier New', monospace", weight: 700, spacing: '0.04em' },
};
export const LOOK_SHAPES = { badge: 'Badge', circle: 'Circle', pill: 'Pill', tilt: 'Sticker', bare: 'Just text' };
// Long names become a cable-style acronym ("Cartoon Network" → CN); short ones stay whole.
export function acronymFor(name) {
  const words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.join('').length <= 7) return words.join(' ').toUpperCase();
  if (words.length >= 2) return words.slice(0, 4).map((w) => w[0]).join('').toUpperCase();
  return words[0].slice(0, 4).toUpperCase();
}
// A darker companion for gradient backgrounds.
export function shade(hex, f = 0.45) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
  if (!m) return '#1a1d29';
  const n = parseInt(m[1], 16);
  const d = (x) => Math.round(x * (1 - f));
  return '#' + [d(n >> 16 & 255), d(n >> 8 & 255), d(n & 255)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// Inline pieces of a look, shared by the small logo and the big bumper card.
export function lookStyle(ch, size) {
  const lk = ch?.look || {};
  const f = LOOK_FONTS[lk.font] || LOOK_FONTS.modern;
  const c1 = lk.c1 || ch?.color || '#6c8cff';
  const c2 = lk.c2 || shade(c1);
  const text = lk.text || acronymFor(ch?.name);
  const fit = text.length <= 2 ? 0.46 : text.length <= 3 ? 0.36 : text.length <= 5 ? 0.27 : 0.2;
  return { f, c1, c2, text, shape: lk.shape || 'badge', fontSize: Math.max(9, Math.round(size * fit)) };
}

export function ChannelLogo({ ch, size = 34, radius }) {
  const base = `width:${size}px;height:${size}px;border-radius:${radius ?? Math.round(size * 0.26)}px`;
  // Live stations bring their own logo.
  if (ch?.iptv?.logo) return html`<div class="chlogo-sm chlogo-img" style=${base + ';background:#fff;font-size:' + Math.round(size * 0.46) + 'px'}><img src=${ch.iptv.logo} alt="" onError=${(e) => { const box = e.target.parentElement; e.target.replaceWith(document.createTextNode((ch.name || '?').slice(0, 2).toUpperCase())); if (box) box.style.background = ch.color || '#333'; }} /></div>`;
  // A picture of your own (falls back to initials if the picture file is gone).
  if (ch?.look?.custom) return html`<div class="chlogo-sm chlogo-img" style=${base + ';background:rgba(255,255,255,.06)'}><img src=${ch.look.custom} alt="" onError=${(e) => { e.target.replaceWith(document.createTextNode((ch.name || '?').slice(0, 2).toUpperCase())); }} /></div>`;
  // The made network logo: font + shape + colors, acronym for long names.
  if (ch?.look) {
    const { f, c1, c2, text, shape, fontSize } = lookStyle(ch, size);
    const sh = shape === 'circle' ? `border-radius:50%` : shape === 'pill' ? `border-radius:${size / 2}px` : shape === 'tilt' ? `border-radius:${Math.round(size * 0.18)}px;transform:rotate(-5deg)` : '';
    const bg = shape === 'bare' ? 'background:transparent' : `background:linear-gradient(135deg, ${c1}, ${c2})`;
    const col = shape === 'bare' ? `color:${c1};text-shadow:0 1px 6px rgba(0,0,0,.55)` : 'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.35)';
    return html`<div class=${'chlogo-sm look'} style=${`${base};${bg};${sh};${col};font-family:${f.css};font-weight:${f.weight};letter-spacing:${f.spacing};font-size:${fontSize}px`}>${text}</div>`;
  }
  const text = ch?.logo || (ch?.name || '?').replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '#';
  return html`<div class="chlogo-sm" style=${base + `;font-size:${Math.round(size * 0.46)}px;background:${ch?.color || '#333'}`}>${text}</div>`;
}

const svg = (d, extra = '') => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: d + extra }}></svg>`;
export const Icon = {
  guide: () => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/>'),
  channels: () => svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="m8 3 4 4 4-4"/>'),
  library: () => svg('<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="m16 5 3.5-1 2.5 15-3.5 1z"/>'),
  settings: () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  fullscreen: () => svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exitFull: () => svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  up: () => svg('<path d="m6 15 6-6 6 6"/>'),
  down: () => svg('<path d="m6 9 6 6 6-6"/>'),
  left: () => svg('<path d="m15 6-6 6 6 6"/>'),
  right: () => svg('<path d="m9 6 6 6-6 6"/>'),
  vol: () => svg('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  mute: () => svg('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>'),
  play: () => svg('<path d="M7 4v16l13-8z" fill="currentColor"/>'),
  pause: () => svg('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>'),
  info: () => svg('<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>'),
  plus: () => svg('<path d="M12 5v14M5 12h14"/>'),
  close: () => svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  edit: () => svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  trash: () => svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  folder: () => svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  scan: () => svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  sparkle: () => svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>'),
  live: () => svg('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"/>'),
  refresh: () => svg('<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>'),
  import: () => svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  min: () => svg('<path d="M5 12h14"/>'),
  max: () => svg('<rect x="5" y="5" width="14" height="14" rx="1.5"/>'),
  game: () => svg('<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 11v3M5.5 12.5h3M15.5 12h.01M18 13.5h.01"/>'),
  pip: () => svg('<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="11" y="12" width="8" height="5.5" rx="1" fill="currentColor" stroke="none"/>'),
  next: () => svg('<path d="M5 5v14l10-7z" fill="currentColor"/><path d="M19 5v14"/>'),
  back10: () => svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', '<text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="800" fill="currentColor" stroke="none">10</text>'),
  fwd10: () => svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', '<text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="800" fill="currentColor" stroke="none">10</text>'),
  sun: () => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
};

// The HomeCable mark (same artwork as the app icon).
export const Logo = ({ size = 24 }) => html`<img src="../../assets/icon.svg" width=${size} height=${size} alt="" />`;
