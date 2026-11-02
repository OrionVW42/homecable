// A stand-in for the <video> element while casting. The player keeps all of its
// cable logic (schedules, mid-show tune-in, DVR rewind/fast-forward, end-of-show
// re-tunes) and simply talks to this object; it forwards to the Chromecast and
// reports back the TV's playback state as ordinary media events.
import { tv } from './util.js';

export class CastMedia extends EventTarget {
  constructor() {
    super();
    this._src = '';
    this._t = 0;            // position at the last status
    this._at = 0;           // performance.now() of the last status
    this._running = false;  // the TV is actually playing (position advances)
    this._started = false;  // LOAD sent for the current source
    this._startAt = 0;
    this._minMsid = 0;      // ignore status from media we've already replaced
    this._seenMsid = 0;
    this._seq = 0;
    this.paused = true;
    this.error = null;
    this.duration = NaN;
    this.meta = {};
    this.volume = 1; this.muted = false; // the TV's own volume is left alone
    this._off = tv.onCastMedia((st) => this._status(st));
    this._poll = setInterval(() => { if (this._started) tv.castControl('STATUS'); }, 4000);
  }

  dispose() { this._off?.(); clearInterval(this._poll); }

  get src() { return this._src; }
  set src(u) { this._src = u || ''; }
  removeAttribute(name) { if (name === 'src') this._src = ''; }

  get currentTime() { return this._running ? this._t + (performance.now() - this._at) / 1000 : this._t; }
  set currentTime(t) {
    this._t = t; this._at = performance.now();
    if (!this._started) { this._startAt = t; return; }
    tv.castControl('SEEK', t);
  }
  // Live stations: no rewind buffer on the TV, so "buffered" is right where we are.
  get buffered() { const n = this.currentTime; return { length: 1, start: () => n, end: () => n + 0.5 }; }

  load() {
    const seq = ++this._seq;
    this._started = false; this._running = false; this._startAt = 0; this._t = 0;
    this.paused = true; this.error = null;
    if (!this._src) return;
    // Pretend we know the length (Infinity) so the player can say where to start.
    this.duration = Infinity;
    queueMicrotask(() => { if (seq === this._seq) this.dispatchEvent(new Event('loadedmetadata')); });
  }

  play() {
    if (!this._src) return Promise.resolve();
    this.paused = false;
    if (this._started) { tv.castControl('PLAY'); return Promise.resolve(); }
    this._started = true;
    this._minMsid = this._seenMsid + 1; // the TV numbers each new load higher
    const seq = this._seq;
    const m = this.meta || {};
    return tv.castLoad({ url: this._src, startAt: this._startAt, title: m.title, subtitle: m.subtitle, image: m.image, audioOnly: m.audioOnly }).then((r) => {
      if (seq !== this._seq) return;
      if (!r?.ok) { this.error = { code: 4, message: r?.error || 'The TV couldn’t play this' }; this.dispatchEvent(new Event('error')); return; }
      if (r.mediaSessionId != null) this._minMsid = r.mediaSessionId;
    }).catch(() => {});
  }

  pause() {
    this._t = this.currentTime; this._running = false; this.paused = true;
    if (this._started) tv.castControl('PAUSE');
  }

  _status(st) {
    if (st.mediaSessionId > this._seenMsid) this._seenMsid = st.mediaSessionId;
    if (!this._started || st.mediaSessionId == null || st.mediaSessionId < this._minMsid) return;
    if (typeof st.currentTime === 'number') { this._t = st.currentTime; this._at = performance.now(); }
    if (st.playerState === 'PLAYING') {
      const was = this._running;
      this._running = true; this.paused = false;
      if (!was) this.dispatchEvent(new Event('playing'));
    } else if (st.playerState === 'BUFFERING') {
      this._running = false;
    } else if (st.playerState === 'PAUSED') {
      this._running = false; this.paused = true;
    } else if (st.playerState === 'IDLE') {
      this._running = false;
      if (st.idleReason === 'FINISHED') { this._started = false; this.dispatchEvent(new Event('ended')); }
      else if (st.idleReason === 'ERROR') { this._started = false; this.error = { code: 4, message: 'The TV couldn’t play this' }; this.dispatchEvent(new Event('error')); }
    }
  }
}
