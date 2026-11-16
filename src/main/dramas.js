// Short dramas: series and channels on YouTube, played through YouTube's own embedded player.
// Only YouTube's public feeds and oEmbed are used here; nothing is downloaded or scraped, and the
// videos play (with YouTube's ads, under YouTube's terms) from youtube-nocookie.com.
const UA = { 'User-Agent': 'HomeCable (home media player)' };
const FEED = 'https://www.youtube.com/feeds/videos.xml';
const CHANNEL_TTL = 60 * 60e3;
const TITLES_KEPT = 4000;

// Official studio channels, and one complete series of theirs, to start with. Removable.
const STARTERS = {
  series: [{ id: 'pl:PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5', kind: 'playlist', ref: 'PLjUIVErGlv-QGTgBOIPllJzdqZEZCfTX5', title: 'Cheer Up Baby!', by: 'DramaBox' }],
  channels: [
    { id: 'ch:UC23wOTsr0ZZrZoyU2jWk6Kw', ref: 'UC23wOTsr0ZZrZoyU2jWk6Kw', name: 'DramaBox' },
    { id: 'ch:UCTP044C5E93eiI0xFM6eVUQ', ref: 'UCTP044C5E93eiI0xFM6eVUQ', name: 'ReelShort' },
  ],
};

const ID = /^[A-Za-z0-9_-]+$/;
// What a pasted link points at: a playlist (a series), a single video, or a channel.
function parseLink(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { return { error: 'Paste a YouTube link.' }; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (!['youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) return { error: 'Only YouTube links work here.' };
  const list = u.searchParams.get('list');
  if (list && ID.test(list) && !/^(RD|UL|LL|WL)/.test(list)) return { kind: 'playlist', ref: list };
  const v = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || (/^\/(shorts|embed|live)\/([^/]+)/.exec(u.pathname) || [])[2];
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return { kind: 'video', ref: v };
  const ch = /^\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(u.pathname);
  if (ch) return { kind: 'channel', ref: ch[1] };
  if (/^\/(@|c\/|user\/)/.test(u.pathname)) return { error: 'For a channel, paste a link to one of its playlists, or its youtube.com/channel/UC… link (YouTube → the channel → About → Share channel → Copy channel ID).' };
  return { error: 'That link isn’t a YouTube playlist, video or channel.' };
}

const unxml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
// YouTube's public Atom feed for a playlist or channel: its name and its newest entries (up to 15).
function parseFeed(xml) {
  const x = String(xml || '');
  const head = x.split('<entry>')[0];
  const title = unxml((/<title>([^<]*)<\/title>/.exec(head) || [])[1] || '');
  const author = unxml((/<author>\s*<name>([^<]*)<\/name>/.exec(head) || [])[1] || '');
  const videos = x.split('<entry>').slice(1).map((e) => ({
    id: (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e) || [])[1],
    title: unxml((/<title>([^<]*)<\/title>/.exec(e) || [])[1] || ''),
    published: (/<published>([^<]+)<\/published>/.exec(e) || [])[1] || '',
  })).filter((v) => v.id && /^[A-Za-z0-9_-]{11}$/.test(v.id));
  return { title, author, videos };
}
async function feed(kind, ref) {
  const r = await fetch(`${FEED}?${kind === 'channel' ? 'channel_id' : 'playlist_id'}=${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(15000), headers: UA });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error('YouTube didn’t answer (' + r.status + ')');
  return parseFeed(await r.text());
}
// A video's title, and whether its owner lets it play outside YouTube (oEmbed says no with 401/403).
async function oembed(id) {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: AbortSignal.timeout(15000), headers: UA });
  if (r.status === 401 || r.status === 403) return { title: '', embed: false };
  if (r.status === 404 || r.status === 400) return { title: '', embed: false, gone: true };
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return { title: String(j.title || ''), embed: true, by: String(j.author_name || '') };
}
const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

class Dramas {
  constructor({ store, log = () => {} }) {
    this.store = store; this.log = log;
    this.d = store.read('dramas', null);
    if (!this.d) { this.d = { series: STARTERS.series.map((s) => ({ ...s })), channels: STARTERS.channels.map((c) => ({ ...c })), progress: {}, titles: {} }; this._save(); }
    for (const k of ['series', 'channels']) this.d[k] = Array.isArray(this.d[k]) ? this.d[k] : [];
    this.d.progress = this.d.progress || {}; this.d.titles = this.d.titles || {};
    this.cache = new Map(); // channel/playlist feeds, for an hour
  }
  _save() { clearTimeout(this._t); this._t = setTimeout(() => this.store.write('dramas', this.d), 500); this._t.unref?.(); }
  async _feed(kind, ref, fresh = false) {
    const k = kind + ':' + ref, c = this.cache.get(k);
    if (c && !fresh && Date.now() - c.at < CHANNEL_TTL) return c.f;
    const f = await feed(kind, ref);
    this.cache.set(k, { at: Date.now(), f });
    return f;
  }
  async home() {
    const series = await Promise.all(this.d.series.map(async (s) => {
      let f = null;
      if (s.kind === 'playlist') f = await this._feed('playlist', s.ref).catch(() => null);
      const first = s.kind === 'video' ? s.ref : f?.videos[0]?.id;
      return { id: s.id, kind: s.kind, ref: s.ref, title: s.title || f?.title || 'Series', by: s.by || f?.author || '', thumb: first ? thumb(first) : null, progress: this.d.progress[s.id] || null };
    }));
    const channels = await Promise.all(this.d.channels.map(async (c) => {
      const f = await this._feed('channel', c.ref).catch(() => null);
      return { id: c.id, name: c.name || f?.title || 'Channel', failed: !f, videos: (f?.videos || []).map((v) => ({ ...v, thumb: thumb(v.id), progress: this.d.progress['v:' + v.id] || null })) };
    }));
    return { series, channels };
  }
  async add(text) {
    const p = parseLink(text);
    if (p.error) throw new Error(p.error);
    const id = (p.kind === 'playlist' ? 'pl:' : p.kind === 'video' ? 'v:' : 'ch:') + p.ref;
    if ([...this.d.series, ...this.d.channels].some((x) => x.id === id)) return { already: true, id, kind: p.kind };
    if (p.kind === 'channel') {
      const f = await this._feed('channel', p.ref, true);
      if (!f) throw new Error('YouTube doesn’t know that channel.');
      this.d.channels.push({ id, ref: p.ref, name: f.title.slice(0, 80) });
    } else if (p.kind === 'playlist') {
      const f = await this._feed('playlist', p.ref, true);
      if (!f) throw new Error('That playlist is private, or doesn’t exist.');
      this.d.series.unshift({ id, kind: 'playlist', ref: p.ref, title: f.title.replace(/【FULL】/g, '').replace(/[【】]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100), by: f.author.slice(0, 60) });
    } else {
      const o = await oembed(p.ref);
      if (o.gone) throw new Error('That video doesn’t exist.');
      if (!o.embed) throw new Error('Its owner only lets it play on YouTube itself.');
      this.d.series.unshift({ id, kind: 'video', ref: p.ref, title: o.title.slice(0, 100), by: o.by.slice(0, 60) });
    }
    this._save();
    return { added: true, id, kind: p.kind };
  }
  remove(id) {
    this.d.series = this.d.series.filter((x) => x.id !== id);
    this.d.channels = this.d.channels.filter((x) => x.id !== id);
    delete this.d.progress[id];
    this._save();
    return true;
  }
  // Episode titles (and whether each can play here), asked a few at a time and remembered.
  async titles(ids) {
    const want = [...new Set((ids || []).filter((x) => /^[A-Za-z0-9_-]{11}$/.test(x)))].slice(0, 300);
    const todo = want.filter((x) => !this.d.titles[x]);
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < todo.length) { const id = todo[i++]; try { this.d.titles[id] = await oembed(id); } catch {} }
    }));
    const keys = Object.keys(this.d.titles);
    if (keys.length > TITLES_KEPT) for (const k of keys.slice(0, keys.length - TITLES_KEPT)) delete this.d.titles[k];
    if (todo.length) this._save();
    return Object.fromEntries(want.map((x) => [x, this.d.titles[x] || null]));
  }
  // Where you are in a series (episode number, seconds in, how many episodes).
  progress(id, p) {
    if (!/^(pl|v):/.test(String(id))) return false;
    this.d.progress[id] = { i: Math.max(0, +p?.i || 0), t: Math.max(0, +p?.t || 0), n: Math.max(0, +p?.n || 0), done: !!p?.done, at: Date.now() };
    this._save();
    return true;
  }
}

module.exports = { Dramas, parseLink, parseFeed, STARTERS };
