// Live captions: listen to what's playing (the same sound you hear, so pausing and
// rewinding just work), cut it into short pieces at the pauses in speech, and have the
// PC's captions engine turn each piece into a line of text.
import { elementAudio } from './audio.js';
import { tv } from './util.js';

const RATE = 16000;
export function startLiveCaptions(el, onText, onError) {
  const { ctx, src } = elementAudio(el);
  const proc = ctx.createScriptProcessor(4096, 2, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0; // keeps the processor running without adding sound
  src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  const step = ctx.sampleRate / RATE;
  let parts = [], len = 0, quietMs = 0, loud = 0, carry = 0, busy = 0, stopped = false, failed = false;
  let level = 0.05; // running loudness: a "pause" is quieter than what's been playing (music beds included)
  let prompt = ''; // the last line, so sentences carry on naturally
  let lastText = '';
  const pending = []; // pieces waiting for the engine — kept, not dropped (freshest two)

  const pump = () => {
    if (stopped || busy >= 1 || !pending.length) return;
    const all = pending.shift();
    busy++;
    tv.captionsChunk(all.buffer, prompt).then((text) => {
      if (stopped || !text) return;
      prompt = text.slice(-200);
      if (text !== lastText) { lastText = text; onText(text); } // echoes of the same line stay off screen
    })
      .catch((e) => { if (!failed && !stopped) { failed = true; onError?.(e); } })
      .finally(() => { busy--; pump(); });
  };
  const flush = () => {
    if (!len) return;
    const all = new Int16Array(len);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    const hadVoice = loud > 0;
    parts = []; len = 0; loud = 0; quietMs = 0;
    if (!hadVoice) return; // silence
    pending.push(all);
    if (pending.length > 2) pending.shift(); // far behind: keep the freshest speech
    pump();
  };

  proc.onaudioprocess = (e) => {
    if (stopped || el.paused) return;
    const a = e.inputBuffer;
    const c0 = a.getChannelData(0), c1 = a.numberOfChannels > 1 ? a.getChannelData(1) : c0;
    const out = [];
    let sum = 0;
    // Mix to mono and pick every `step`-th sample (averaging the samples in between).
    let x = carry;
    for (; x < c0.length; x += step) {
      const i = Math.floor(x), j = Math.min(c0.length - 1, Math.floor(x + step) - 1);
      let s = 0, n = 0;
      for (let k = i; k <= Math.max(i, j); k++) { s += (c0[k] + c1[k]) / 2; n++; }
      const v = s / n;
      sum += v * v;
      out.push(Math.max(-1, Math.min(1, v)) * 32767);
    }
    carry = x - c0.length; // where the next block's first sample falls
    const rms = Math.sqrt(sum / Math.max(1, out.length));
    const ms = (out.length / RATE) * 1000;
    level = level * 0.97 + rms * 0.03;
    if (rms > 0.015 && rms > level * 0.55) { loud++; quietMs = 0; } else quietMs += ms;
    parts.push(Int16Array.from(out));
    len += out.length;
    const secs = len / RATE;
    // Cut at a pause once there's enough to say something, and never wait too long.
    if ((secs >= 1.2 && quietMs >= 220) || secs >= 3.2) flush();
  };

  return () => { stopped = true; try { src.disconnect(proc); } catch {} try { proc.disconnect(); sink.disconnect(); } catch {} proc.onaudioprocess = null; };
}
