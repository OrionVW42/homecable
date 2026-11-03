// The welcome tour: one quick, fully skippable walkthrough of everything —
// shown once after first-time setup, and any time from Settings → Welcome tour.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { Logo } from './util.js';

const SLIDES = [
  {
    icon: '📺', title: 'It works like real cable',
    lines: [
      ['Channels are always on — you join shows in progress, just like TV.', null],
      ['Flip channels', '↑ ↓'],
      ['Jump straight to one by typing its number', '2 4'],
      ['Back to the last channel', 'Backspace'],
      ['Pause and rewind live TV any time', 'Space , .'],
    ],
  },
  {
    icon: '🗓', title: 'The Guide shows what’s on',
    lines: [
      ['Open the cable-style grid of every channel’s schedule.', 'G'],
      ['Arrow around, press Enter to watch.', 'Enter'],
      ['Live TV programs can be mixed into your own channels — the 5 PM news on your channel, every day.', 'M'],
    ],
  },
  {
    icon: '🎬', title: 'On Demand & Stream Demand',
    lines: [
      ['On Demand is a wall of your movies — pick one, watch from the start, it remembers where you stopped.', null],
      ['Stream Demand is for binge-watching shows: seasons, episodes, and the next one plays itself.', null],
      ['Drop new files in their folders and they just appear — no importing.', null],
    ],
  },
  {
    icon: '🎨', title: 'Make the channels your own',
    lines: [
      ['Everything that edits lives in one place: the Edit menu, top of the screen.', null],
      ['Manage channels: add shows and movies to any channel, with suggestions that fit it.', 'E'],
      ['Give each channel a network logo — fonts, colors, shapes, or your own picture.', null],
      ['Channel bumpers play a few seconds of your channel’s logo between shows, like a real network. Commercials (just for fun) are in Settings.', null],
    ],
  },
  {
    icon: '🏷', title: 'Tags and info, done for you',
    lines: [
      ['Edit → Tags: every show and movie with its tags right there — or press Auto-tag everything.', null],
      ['HomeCable looks names up online (titles only), fixes posters, finds genres, knows anime, and puts OVAs in airing order.', null],
      ['Hold or right-click any poster to fix its name, picture or tags by hand.', null],
    ],
  },
  {
    icon: '📱', title: 'Watch all over the house',
    lines: [
      ['Cast to a Chromecast or Google TV.', 'K'],
      ['Pair phones and tablets with a QR code (Settings → Phone app): watch anywhere, or use one as the remote — even for the TV.', null],
      ['Profiles keep kids on kid-friendly channels; your stuff stays yours.', null],
      ['Pop-out player: a small always-on-top window while you work.', 'P'],
    ],
  },
  {
    icon: '🚀', title: 'You’re all set',
    lines: [
      ['Settings has the rest: subtitles, dubs, folders, free live TV, commercials and more.', 'S'],
      ['Press ? any time for every control, and replay this tour from Settings.', '?'],
      ['Now — back to the couch.', null],
    ],
  },
];

export function Tour({ onClose }) {
  const [i, setI] = useState(0);
  const s = SLIDES[i];
  const last = i === SLIDES.length - 1;
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') (last ? onClose() : setI((n) => Math.min(SLIDES.length - 1, n + 1)));
      else if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [i, last]);
  return html`<div class="tour">
    <div class="tour-card" key=${i}>
      <button class="btn ghost sm tour-skip" onClick=${onClose}>Skip the tour ✕</button>
      <div class="tour-brand"><${Logo} size=${26} /> Welcome to HomeCable</div>
      <div class="tour-icon">${s.icon}</div>
      <h1>${s.title}</h1>
      <div class="tour-lines">
        ${s.lines.map(([text, keys]) => html`<div class="tour-line">${keys && html`<span class="tour-keys">${keys.split(' ').map((k) => html`<kbd>${k}</kbd>`)}</span>`}<span>${text}</span></div>`)}
      </div>
      <div class="tour-nav">
        <button class="btn" disabled=${i === 0} onClick=${() => setI(i - 1)}>Back</button>
        <div class="tour-dots">${SLIDES.map((_, j) => html`<i class=${j === i ? 'on' : ''} onClick=${() => setI(j)}></i>`)}</div>
        <button class="btn primary big" onClick=${() => (last ? onClose() : setI(i + 1))}>${last ? '▶ Start watching' : 'Next'}</button>
      </div>
    </div>
  </div>`;
}
