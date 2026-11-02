// One audio graph for the TV picture's sound. A media element can only be wired
// into Web Audio once, so the music visualizer and screen mirroring share it:
//   <video> → source → out ──→ speakers            (normal)
//                         └─→ mirror stream only    (while mirroring to a TV)
let ctx = null;
const nodes = new WeakMap();

export function elementAudio(el) {
  if (!ctx) ctx = new AudioContext();
  if (!nodes.has(el)) {
    const src = ctx.createMediaElementSource(el);
    const out = ctx.createGain();
    src.connect(out);
    out.connect(ctx.destination);
    nodes.set(el, { src, out });
  }
  ctx.resume().catch(() => {});
  return { ctx, ...nodes.get(el) };
}

// Send the picture's sound to `dest` instead of the PC speakers (or back, with null).
export function routeAudio(el, dest) {
  const { ctx: c, out } = elementAudio(el);
  out.disconnect();
  out.connect(dest || c.destination);
}

// While live captions listen, the element plays at full level into the graph and the
// volume / mute you chose is applied after it — muting the TV doesn't silence the captions.
export function setLevel(el, level) {
  const { ctx: c, out } = elementAudio(el);
  out.gain.setTargetAtTime(level, c.currentTime, 0.02);
}
