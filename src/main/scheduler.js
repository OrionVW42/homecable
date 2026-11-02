// Builds each channel's broadcast timeline ahead of time, like a real station:
// programs, scheduled time blocks, filler to the half hour, and "off air".
//
// Entry: { start, end, type: 'program'|'filler'|'upnext'|'offair', itemId?, title, show?, season?, episode?, offset? }
// Timelines are materialized and persisted, so tuning away and back keeps
// "live" position, and new content only affects the future.

const HOUR = 3600e3;
const HORIZON = 26 * HOUR;     // keep this much programming ahead of now
const KEEP_PAST = 3 * HOUR;
const MIN_GAP = 4e3;           // gaps shorter than this are absorbed
const MAX_DEAD_AIR = 5 * 60e3;
const MAX_CATCH_UP = 400 * 24 * HOUR; // channels "kept airing" while the app was closed, up to ~a year

function parseHM(s) {
  const [h, m] = String(s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// All block occurrences overlapping [from, to). Blocks use local wall-clock time.
function blockOccurrences(blocks, from, to) {
  const out = [];
  if (!blocks?.length) return out;
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1); // catch overnight blocks that started yesterday
  for (; d.getTime() < to; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const b of blocks) {
      // One-off blocks have a date; repeating ones have days of the week.
      if (b.date ? b.date !== ymd : !b.days?.includes(day)) continue;
      const s = parseHM(b.start), e = parseHM(b.end);
      const start = new Date(d); start.setMinutes(s);
      const end = new Date(d); end.setMinutes(e <= s ? e + 24 * 60 : e);
      if (end.getTime() > from && start.getTime() < to) out.push({ block: b, start: start.getTime(), end: end.getTime() });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// exclude: things taken off the channel by hand ("show:<key>" / "item:<id>").
function poolItems(lib, sources, exclude) {
  const seen = new Set();
  const ex = new Set(exclude || []);
  const out = [];
  for (const s of sources || []) for (const it of lib.resolve(s)) {
    if (seen.has(it.id) || !(it.duration > 0)) continue;
    if (ex.size && (ex.has('item:' + it.id) || (it.showKey && ex.has('show:' + it.showKey)) || (it.showKeyUser && ex.has('show:' + it.showKeyUser)))) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

const groupOf = (it) => it.showKey || ('item:' + it.id);

// A picker hands out the next item for a pool without consuming it until commit().
// Cursor state is plain JSON so it can be persisted between runs.
function makePicker(items, order, cur, rng) {
  const byId = new Map(items.map((it) => [it.id, it]));
  if (!items.length) return null;

  if (order === 'shuffle') {
    cur.bag = (cur.bag || []).filter((id) => byId.has(id));
    // New content joins the current bag right away.
    const inBag = new Set(cur.bag);
    const recent = new Set(cur.recent || []);
    for (const it of items) if (!inBag.has(it.id) && !recent.has(it.id)) cur.bag.splice(Math.floor(rng() * (cur.bag.length + 1)), 0, it.id);
    const refill = () => {
      const recentArr = cur.recent || [];
      cur.bag = shuffle(items.map((i) => i.id), rng);
      // Don't let the last thing aired lead the new bag.
      if (cur.bag.length > 1 && cur.bag[0] === recentArr[recentArr.length - 1]) cur.bag.push(cur.bag.shift());
    };
    if (!cur.bag.length) refill();
    return {
      peek: (maxDur) => {
        if (!cur.bag.length) refill();
        const idx = maxDur == null ? 0 : cur.bag.findIndex((id) => byId.get(id).duration * 1000 <= maxDur);
        return idx < 0 ? null : byId.get(cur.bag[idx]);
      },
      commit: (it) => {
        cur.bag = cur.bag.filter((id) => id !== it.id);
        cur.recent = [...(cur.recent || []).filter((id) => id !== it.id), it.id].slice(-Math.min(20, Math.floor(items.length / 2)));
      },
    };
  }

  if (order === 'ordered') {
    const next = () => {
      const i = items.findIndex((it) => it.id === cur.last);
      return items[(i + 1) % items.length];
    };
    return { peek: (maxDur) => { const it = next(); return maxDur == null || it.duration * 1000 <= maxDur ? it : null; }, commit: (it) => { cur.last = it.id; } };
  }

  // 'random': fully random, anything any time (never the same thing twice in a row).
  if (order === 'random') {
    return {
      peek: (maxDur) => {
        let pool = items.filter((it) => (maxDur == null || it.duration * 1000 <= maxDur) && it.id !== cur.last);
        if (!pool.length) pool = items.filter((it) => maxDur == null || it.duration * 1000 <= maxDur);
        return pool.length ? pool[Math.floor(rng() * pool.length)] : null;
      },
      commit: (it) => { cur.last = it.id; },
    };
  }

  // 'sequential': each show plays its episodes in order; shows take turns.
  const groups = new Map();
  for (const it of items) { const g = groupOf(it); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
  cur.last = cur.last || {};
  const keys = [...groups.keys()];
  cur.rotation = (cur.rotation || []).filter((k) => groups.has(k));
  const nextIn = (g) => {
    const list = groups.get(g);
    const i = list.findIndex((it) => it.id === cur.last[g]);
    return list[(i + 1) % list.length];
  };
  const ensureRotation = () => {
    if (!cur.rotation.length) {
      // Single-episode groups (loose movies/clips) shouldn't dominate a mixed channel.
      cur.rotation = shuffle([...keys], rng);
      if (keys.length > 1 && cur.rotation[0] === cur.prevGroup) cur.rotation.push(cur.rotation.shift());
    }
  };
  return {
    peek: (maxDur) => {
      ensureRotation();
      for (const g of cur.rotation) {
        const it = nextIn(g);
        if (maxDur == null || it.duration * 1000 <= maxDur) return it;
      }
      return null;
    },
    commit: (it) => {
      const g = groupOf(it);
      cur.last[g] = it.id;
      cur.rotation = cur.rotation.filter((k) => k !== g);
      cur.prevGroup = g;
    },
  };
}

function entryFor(it, start, type = 'program') {
  return {
    start, end: start + Math.round(it.duration * 1000), type, itemId: it.id, title: it.title,
    show: it.show || null, season: it.season ?? null, episode: it.episode ?? null, kind: it.kind,
  };
}

class Scheduler {
  constructor(store, library, rng = Math.random) {
    this.store = store;
    this.lib = library;
    this.rng = rng;
    this.state = store ? store.read('schedule', {}) : {};
    // Commercial breaks: { enabled, seconds, every: 'every'|'other'|'few', pool: () => [{ id, duration, title, card? }] }
    this.ads = null;
    // Channel bumpers (station idents): { enabled, seconds } — a few seconds of the
    // channel's logo between shows, and in/out of commercial breaks.
    this.idents = null;
    this._saveTimer = null;
  }

  save() {
    if (!this.store) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.store.write('schedule', this.state), 500);
  }

  stateOf(ch) {
    if (!this.state[ch.id]) this.state[ch.id] = { programs: [], until: 0, cursors: {} };
    return this.state[ch.id];
  }

  fillGap(ch, st, from, to, fillerPicker, out) {
    let t = from;
    let guard = 0;
    while (to - t >= MIN_GAP && guard++ < 200) {
      const left = to - t;
      const it = fillerPicker && left > 15e3 ? fillerPicker.peek(left) : null;
      if (it) { fillerPicker.commit(it); const e = entryFor(it, t, 'filler'); out.push(e); t = e.end; continue; }
      out.push({ start: t, end: to, type: 'upnext', title: 'Up Next' });
      t = to;
    }
    if (t < to && out.length) out[out.length - 1].end = to;
    return to;
  }

  // Extend a channel's timeline to `until`.
  extend(ch, now, until) {
    const st = this.stateOf(ch);
    const rng = this.rng;
    const align = (ch.align ?? 30) * 60e3;
    // Back-to-back ("align 0"): one continuous network. The next show starts the
    // moment the last one ends, picked from whatever block covers that moment; a
    // block whose time comes mid-show takes over when that show ends; and between
    // blocks the last block keeps playing. Only live blocks (e.g. the 5 pm news)
    // still start exactly on time.
    const soft = align === 0;
    // Channels never stop: if the app was closed, carry on from where the
    // timeline ended and air everything in between (episodes keep advancing),
    // as if the station had been broadcasting the whole time.
    let t = st.until && st.until > now - MAX_CATCH_UP ? st.until : Math.floor(now / (30 * 60e3)) * 30 * 60e3;
    const out = [];

    const mainItems = poolItems(this.lib, ch.sources, ch.exclude);
    st.cursors.main = st.cursors.main || {};
    const main = makePicker(mainItems, ch.order || 'sequential', st.cursors.main, rng);
    const fillerItems = poolItems(this.lib, ch.filler, ch.exclude);
    st.cursors.filler = st.cursors.filler || {};
    const filler = makePicker(fillerItems, 'shuffle', st.cursors.filler, rng);
    const blockPickers = new Map();
    const pickerForBlock = (b) => {
      if (!blockPickers.has(b.id)) {
        const cur = st.cursors['b:' + b.id] = st.cursors['b:' + b.id] || {};
        const items = poolItems(this.lib, b.sources, ch.exclude);
        // Imported schedules remember how far into the folder they were.
        if (b.order === 'ordered' && b.startAt > 0 && !cur.last && items.length) cur.last = items[(b.startAt - 1) % items.length].id;
        blockPickers.set(b.id, makePicker(items, b.order || 'sequential', cur, rng));
      }
      return blockPickers.get(b.id);
    };

    const occ = blockOccurrences(ch.blocks, t - (soft ? 8 * 24 : 24) * HOUR, until + 24 * HOUR);
    const isLive = (o) => o.block.sources?.some((x) => x.type === 'live');
    // Commercial break after a program (if turned on): random joke ads up to the chosen length.
    const ads = this.ads?.enabled ? this.ads : null;
    const adPool = ads ? ads.pool() : [];
    st.cursors.ads = st.cursors.ads || {};
    const adPicker = adPool.length ? makePicker(adPool, 'shuffle', st.cursors.ads, rng) : null;
    // Channel bumpers (station idents): a few seconds of the channel's own logo
    // between shows, like a real network — and in and out of commercial breaks.
    const identLen = Math.max(3, Math.min(10, this.idents?.seconds || 5)) * 1000;
    const ident = (end) => {
      if (!this.idents?.enabled) return end;
      const nb = blockAfter(end);
      if (nb && end + identLen > nb.start) return end; // doesn't fit before the next block
      out.push({ start: end, end: end + identLen, type: 'ident', title: ch.name, variant: Math.floor(rng() * 6) });
      return end + identLen;
    };
    // After a show: bumper, maybe commercials, and a bumper back in when they aired.
    const afterShow = (end) => {
      const t1 = ident(end);
      const t2 = adBreak(t1);
      return t2 > t1 ? ident(t2) : t2;
    };
    const adBreak = (end) => {
      if (!adPicker) return end;
      st.cursors.adN = (st.cursors.adN || 0) + 1;
      if (st.cursors.adN % ({ every: 1, other: 2, few: 4 }[ads.every] || 1)) return end;
      const nb = blockAfter(end);
      let budget = Math.min(ads.seconds * 1000, nb ? nb.start - end : Infinity);
      let at = end, n = 0;
      while (budget >= 3000 && n++ < 12) {
        const ad = adPicker.peek(budget);
        if (!ad) break;
        adPicker.commit(ad);
        const len = Math.round(ad.duration * 1000);
        out.push({ start: at, end: at + len, type: 'ad', itemId: ad.card ? null : ad.id, card: ad.card || null, title: ad.title });
        at += len; budget -= len;
      }
      return at;
    };
    // Time only moves forward, so walk the block list with a cursor (a long
    // catch-up can cross thousands of block occurrences).
    let oi = 0;
    const blockAt = (time) => { while (oi < occ.length && occ[oi].end <= time) oi++; for (let j = oi; j < occ.length && occ[j].start <= time; j++) if (time < occ[j].end) return occ[j]; return null; };
    const blockAfter = (time) => { for (let j = oi; j < occ.length; j++) if (occ[j].start > time) return occ[j]; return null; };
    // Back-to-back: only a live block is a hard deadline.
    const hardAfter = (time) => { for (let j = oi; j < occ.length; j++) if (occ[j].start > time && (!soft || isLive(occ[j]))) return occ[j]; return null; };
    // Back-to-back, between blocks: the most recent (non-live) block keeps going.
    // (time only moves forward, so a cursor keeps this cheap during long catch-ups)
    let li = 0, lastNonLive = null;
    const lastBlock = (time) => { while (li < occ.length && occ[li].start <= time) { if (!isLive(occ[li])) lastNonLive = occ[li]; li++; } return lastNonLive; };
    // After a program, fill to the next :00/:30 (TV shows start on the half hour),
    // but never past the start of a scheduled block.
    const pad = (end) => {
      if (!align) return end;
      let b = Math.ceil(end / align) * align;
      const nb = blockAfter(end);
      if (nb && nb.start < b) b = nb.start;
      // With no breaks/commercials to air, a long "Up next" card is just dead
      // air — start the next show instead.
      if (!filler && b - end > MAX_DEAD_AIR && !(nb && nb.start === b)) return end;
      return b > end ? this.fillGap(ch, st, end, b, filler, out) : end;
    };
    let guard = 0;
    while (t < until && guard++ < 400000) {
      // Long catch-up: keep only the recent past in memory.
      if (out.length > 4000) { st.programs.push(...out.splice(0)); st.programs = st.programs.filter((p) => p.end > now - KEEP_PAST); }
      let inBlock = blockAt(t);
      // Back-to-back with nothing else on the channel: carry on with the last block.
      let carrying = false;
      if (soft && !inBlock && !main) { inBlock = lastBlock(t); carrying = !!inBlock; }
      // A block that plays a live station: the whole slot is that station.
      const liveSrc = inBlock && inBlock.block.sources?.find((s) => s.type === 'live');
      if (liveSrc) {
        out.push({ start: t, end: inBlock.end, type: 'live', liveId: liveSrc.channelId, title: inBlock.block.name || liveSrc.label || 'Live', block: inBlock.block.name || null });
        t = inBlock.end;
        continue;
      }
      if (inBlock) {
        const p = pickerForBlock(inBlock.block);
        const it = p?.peek();
        if (!it) {
          const until2 = carrying ? Math.min(blockAfter(t)?.start ?? t + HOUR, t + HOUR) : inBlock.end;
          t = this.fillGap(ch, st, t, Math.max(until2, t + MIN_GAP), filler, out); continue;
        }
        // Back-to-back: a show that would run into a live block is swapped for one that fits.
        let pick = it;
        if (soft) { const live = hardAfter(t); if (live && t + it.duration * 1000 > live.start) pick = p.peek(live.start - t); }
        if (!pick) { t = this.fillGap(ch, st, t, hardAfter(t).start, filler, out); continue; }
        p.commit(pick);
        const e = entryFor(pick, t);
        e.block = inBlock.block.name || null;
        out.push(e);
        t = pad(afterShow(e.end));
        continue;
      }
      const nextBlock = soft ? hardAfter(t) : blockAfter(t);
      const limit = Math.min(nextBlock ? nextBlock.start : Infinity, until + 12 * HOUR);
      if (!main) {
        // Nothing to play outside blocks: off air until the next block.
        const nb = blockAfter(t);
        const end = Math.min(nb ? nb.start : Infinity, limit, t + HOUR);
        out.push({ start: t, end, type: 'offair', title: nextBlock ? 'Off Air' : 'No programming' });
        t = end;
        continue;
      }
      let it = main.peek();
      if (it && nextBlock && t + it.duration * 1000 > nextBlock.start) it = main.peek(nextBlock.start - t);
      if (!it) { t = this.fillGap(ch, st, t, limit, filler, out); continue; }
      main.commit(it);
      const e = entryFor(it, t);
      out.push(e);
      t = pad(afterShow(e.end));
    }
    st.programs.push(...out);
    st.until = t;
    st.programs = st.programs.filter((p) => p.end > now - KEEP_PAST);
    return out.length;
  }

  ensure(channels, now = Date.now()) {
    let changed = false;
    for (const ch of channels) {
      if (ch.iptv || ch.ondemand) continue; // live stations and on-demand channels have no schedule
      const st = this.stateOf(ch);
      if (st.until < now + HORIZON) { this.extend(ch, now, now + HORIZON + HOUR); changed = true; }
    }
    if (changed) this.save();
  }

  // Throw away the future (after what's airing now) and re-plan. Used after a
  // channel is edited or content disappears.
  rebuild(ch, now = Date.now()) {
    if (ch.ondemand) return;
    const st = this.stateOf(ch);
    const cur = st.programs.find((p) => p.start <= now && now < p.end);
    st.programs = st.programs.filter((p) => p.end <= now);
    // Only a real show in progress keeps playing; placeholders (off air, "up next",
    // breaks, live slots) are re-planned right away so changes take effect now.
    if (cur && cur.type === 'program' && this.lib.items[cur.itemId]) { st.programs.push(cur); st.until = cur.end; }
    else st.until = now;
    this.extend(ch, now, now + HORIZON + HOUR);
    this.save();
  }

  // After a rescan: replan channels whose upcoming items vanished, and channels
  // that had nothing to play before (so new content shows up right away).
  libraryChanged(channels, now = Date.now()) {
    for (const ch of channels) {
      if (ch.iptv || ch.ondemand) continue;
      const st = this.stateOf(ch);
      const future = st.programs.filter((p) => p.end > now);
      const broken = future.some((p) => p.itemId && !this.lib.items[p.itemId]);
      const empty = future.length && future.every((p) => p.type === 'offair' || p.type === 'upnext');
      if (broken || empty) this.rebuild(ch, now);
    }
  }

  remove(chId) { delete this.state[chId]; this.save(); }

  at(ch, t = Date.now()) {
    const ps = this.stateOf(ch).programs;
    let lo = 0, hi = ps.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ps[mid].end <= t) lo = mid + 1;
      else if (ps[mid].start > t) hi = mid - 1;
      else return { entry: ps[mid], next: ps[mid + 1] || null, offset: (t - ps[mid].start) / 1000 };
    }
    return null;
  }

  range(ch, from, to) {
    return this.stateOf(ch).programs.filter((p) => p.end > from && p.start < to);
  }
}

module.exports = { Scheduler, blockOccurrences, makePicker, parseHM, HORIZON };
