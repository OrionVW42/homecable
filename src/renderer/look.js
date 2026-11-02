// The channel's network look: a made logo (font + badge + colors), like a real
// network's mark. Six ready-made options per channel, a shuffle for more, full
// fine-tuning, or a picture of your own. Long names become acronyms (CN-style).
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { tv, ChannelLogo, LOOK_FONTS, LOOK_SHAPES, PALETTE, acronymFor, shade } from './util.js';

const FONT_KEYS = Object.keys(LOOK_FONTS);
const SHAPE_KEYS = Object.keys(LOOK_SHAPES);
const hash = (s) => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

// Six ready-made looks for this channel; a new seed deals a fresh hand.
export function lookVariants(name, color, seed = 0) {
  const h = hash(name) + seed * 13;
  const out = [];
  for (let i = 0; i < 6; i++) {
    const c1 = i === 0 && color ? color : PALETTE[(h + i * 5) % PALETTE.length];
    const c2 = i % 3 === 2 ? shade(PALETTE[(h + i * 5 + 4) % PALETTE.length], 0.2) : shade(c1);
    out.push({ font: FONT_KEYS[(h + i) % FONT_KEYS.length], shape: SHAPE_KEYS[(h + i * 2 + (i > 2 ? 1 : 0)) % SHAPE_KEYS.length], c1, c2, text: '', custom: null });
  }
  return out;
}

const same = (a, b) => a && b && a.font === b.font && a.shape === b.shape && a.c1 === b.c1 && a.c2 === b.c2 && !a.custom && !b.custom;

// value: the channel's `look` (or null = simple emoji/initials logo).
export function LookEditor({ name, color, value, onChange, channelId, toast }) {
  const [seed, setSeed] = useState(0);
  const options = lookVariants(name, color, seed);
  const preview = (lk) => ({ name, color, look: lk });
  const set = (patch) => onChange({ ...(value || options[0]), ...patch });
  const pickFile = async () => {
    if (!channelId) return;
    const url = await tv.channelLogoPick(channelId).catch((e) => { toast?.(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')); return null; });
    if (url) set({ custom: url });
  };
  return html`<div class="look-edit">
    <div class="look-opts">
      ${options.map((lk) => html`<button class=${'look-opt' + (same(value, lk) ? ' on' : '')} title="Use this look" onClick=${() => onChange({ ...lk, text: value?.text || '' })}>
        <${ChannelLogo} ch=${preview(lk)} size=${52} />
      </button>`)}
      <button class="look-opt more" title="Deal six new looks" onClick=${() => setSeed((s) => s + 1)}>🔀<span>More</span></button>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:14px;margin-top:10px;align-items:flex-start">
      ${value && !value.custom && html`
        <label class="field">Font<div class="seg">${FONT_KEYS.map((k) => html`<button class=${(value.font || 'modern') === k ? 'on' : ''} style=${`font-family:${LOOK_FONTS[k].css}`} onClick=${() => set({ font: k })}>${LOOK_FONTS[k].label}</button>`)}</div></label>
        <label class="field">Shape<div class="seg">${SHAPE_KEYS.map((k) => html`<button class=${(value.shape || 'badge') === k ? 'on' : ''} onClick=${() => set({ shape: k })}>${LOOK_SHAPES[k]}</button>`)}</div></label>
        <label class="field">Colors<div class="row" style="gap:10px"><div class="swatches">${PALETTE.map((p) => html`<button title=${'Main: ' + p} class=${value.c1 === p ? 'on' : ''} style=${'background:' + p} onClick=${() => set({ c1: p, c2: value.c2 && value.c2 !== shade(value.c1) ? value.c2 : shade(p) })}></button>`)}</div></div></label>
        <label class="field">Fades into<div class="swatches">${['#14161f', ...PALETTE.map((p) => shade(p, 0.25))].map((p) => html`<button title=${p} class=${value.c2 === p ? 'on' : ''} style=${'background:' + p} onClick=${() => set({ c2: p })}></button>`)}</div></label>
        <label class="field">Logo text<input class="input" style="width:130px" maxlength="14" placeholder=${acronymFor(name)} value=${value.text || ''} onInput=${(e) => set({ text: e.target.value })} /></label>`}
      <label class="field">Your own picture
        <div class="row" style="gap:8px">
          <button class="btn sm" disabled=${!channelId} title=${channelId ? 'Use a picture file as the logo' : 'Save the channel first, then pick a picture'} onClick=${pickFile}>📁 Pick a picture…</button>
          ${value?.custom && html`<button class="btn sm ghost" onClick=${() => set({ custom: null })}>✕ Remove picture</button>`}
        </div></label>
      ${value && html`<label class="field"> <button class="btn sm ghost" title="Back to the plain emoji / initials logo" onClick=${() => onChange(null)}>Aa Simple logo instead</button></label>`}
    </div>
  </div>`;
}
