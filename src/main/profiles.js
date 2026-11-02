// Who's watching: profiles with optional locks (password, PIN, or a controller
// button combo), and what each level is allowed to see.
//   kids   → channels rated for everyone
//   teens  → + teen channels
//   adults → everything, and the only ones who can change settings/channels
const crypto = require('crypto');

const LEVELS = ['kids', 'teens', 'adults'];
const ALLOWS = { kids: ['all'], teens: ['all', 'teen'], adults: ['all', 'teen', 'adult'] };
const AVATARS = ['🙂', '😎', '👵', '👴', '🧑', '👩', '👨', '🧒', '👧', '👦', '🐱', '🐶', '🦊', '🐼', '🦄', '🐸', '🚀', '⚽', '🎮', '🎨'];

const hash = (secret, salt) => crypto.scryptSync(String(secret), salt, 32).toString('hex');
// Same input however it's typed: PINs are digits, combos are button names, passwords as-is.
function normalize(type, secret) {
  if (type === 'pin') return String(secret).replace(/\D/g, '');
  if (type === 'combo') return (Array.isArray(secret) ? secret : String(secret).split(',')).map((b) => String(b).trim().toUpperCase()).filter(Boolean).join(',');
  return String(secret);
}

class Profiles {
  constructor(store) {
    this.store = store;
    const d = store.read('profiles', null);
    this.list = d?.list?.length ? d.list : [{ id: 'me', name: 'Me', avatar: '🙂', level: 'adults', lock: null }];
    this.active = d?.active && this.list.some((p) => p.id === d.active) ? d.active : this.list[0].id;
    this.askAtStart = d?.askAtStart ?? true;
  }
  save() { this.store.write('profiles', { list: this.list, active: this.active, askAtStart: this.askAtStart }); }
  get current() { return this.list.find((p) => p.id === this.active) || this.list[0]; }
  isAdult() { return this.current.level === 'adults'; }
  allows(rating) { return ALLOWS[this.current.level].includes(rating || 'all'); }
  // Shown to the renderer — never the lock hashes.
  view() {
    return {
      list: this.list.map(({ id, name, avatar, level, lock }) => ({ id, name, avatar, level, lock: lock ? lock.type : null, comboLength: lock?.type === 'combo' ? lock.length : undefined })),
      active: this.active, askAtStart: this.askAtStart,
      // Ask at start when there's a choice to make, or when the last profile is locked.
      needsPick: this.list.length > 1 && (this.askAtStart || !!this.current.lock),
    };
  }
  check(id, secret) {
    const p = this.list.find((x) => x.id === id);
    if (!p) return false;
    if (!p.lock) return true;
    const want = Buffer.from(p.lock.hash, 'hex');
    const got = Buffer.from(hash(normalize(p.lock.type, secret ?? ''), p.lock.salt), 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
  switchTo(id, secret) {
    if (!this.check(id, secret)) return false;
    this.active = id;
    this.save();
    return true;
  }
  upsert(p) {
    const cur = this.list.find((x) => x.id === p.id);
    const clean = { name: String(p.name || 'Someone').slice(0, 30), avatar: AVATARS.includes(p.avatar) ? p.avatar : '🙂', level: LEVELS.includes(p.level) ? p.level : 'kids' };
    if (cur) Object.assign(cur, clean);
    else this.list.push({ id: crypto.randomUUID().slice(0, 8), lock: null, ...clean });
    // There must always be a grown-up.
    if (!this.list.some((x) => x.level === 'adults')) (cur || this.list[this.list.length - 1]).level = 'adults';
    this.save();
    return this.view();
  }
  remove(id) {
    const rest = this.list.filter((x) => x.id !== id);
    if (!rest.length || !rest.some((x) => x.level === 'adults')) return this.view(); // keep at least one adult
    this.list = rest;
    if (this.active === id) this.active = rest.find((x) => x.level === 'adults').id;
    this.save();
    return this.view();
  }
  setLock(id, type, secret) {
    const p = this.list.find((x) => x.id === id);
    if (!p) return this.view();
    if (!type) p.lock = null;
    else {
      const s = normalize(type, secret);
      if (type === 'pin' && !/^\d{4,8}$/.test(s)) throw new Error('A PIN is 4 to 8 numbers');
      if (type === 'password' && s.length < 4) throw new Error('Use at least 4 characters');
      if (type === 'combo' && s.split(',').length < 4) throw new Error('A combo needs at least 4 button presses');
      const salt = crypto.randomBytes(16).toString('hex');
      p.lock = { type, salt, hash: hash(s, salt), ...(type === 'combo' ? { length: s.split(',').length } : {}) };
    }
    this.save();
    return this.view();
  }
}

// Default rating for a channel from what's on it. Ratings can always be changed by an adult.
function autoRating(ch, lib) {
  const name = `${ch.name} ${ch.iptv?.group || ''}`.toLowerCase();
  if (/\b(xxx|adult|erotic|playboy|18\+)\b/.test(name)) return 'adult';
  if (ch.iptv) return /\banime\b/.test(name) ? 'teen' : /\b(kids|children|animation|family|cartoon|education|toon)\b/.test(name) ? 'all' : 'teen';
  const kidGenres = new Set(['Children', 'Family', 'Animation']);
  const srcs = [...(ch.sources || []), ...(ch.blocks || []).flatMap((b) => b.sources || [])];
  if (!srcs.length) return 'all';
  const kidSafe = srcs.every((s) => {
    if (s.type === 'server') return /cartoon/i.test(s.id);
    if (s.type === 'show') return (lib.meta[s.key]?.genres || []).some((g) => kidGenres.has(g));
    if (s.type === 'kind') return s.kind === 'music';
    if (s.type === 'live') return false;
    return /cartoon|kids|children|animation|family/i.test(s.label || s.path || '');
  });
  return kidSafe ? 'all' : 'teen';
}

module.exports = { Profiles, autoRating, LEVELS, ALLOWS, AVATARS };
