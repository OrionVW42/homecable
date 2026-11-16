// Adults only: a separate place for live stations a grown-up adds themselves. HomeCable ships,
// lists and recommends none. These helpers are kept apart so they can be tested on their own.
const { parseM3U } = require('./iptv');

const MAX_STATIONS = 500;

// Age in whole years on a given day, from a date of birth typed as YYYY-MM-DD. null when it isn't
// a real date, is in the future, or is before 1900. The date itself is never kept.
function ageOn(birth, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birth || '').trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  if (y < 1900 || dt > now) return null;
  let age = now.getFullYear() - y;
  if (now.getMonth() < mo - 1 || (now.getMonth() === mo - 1 && now.getDate() < d)) age--;
  return age;
}

// What a pasted link holds: a playlist of stations, or one stream on its own.
function readLink(url, text) {
  let host = 'Station';
  try { host = new URL(url).hostname; } catch {}
  const t = String(text || '');
  // A stream's own playlist (HLS) also uses #EXTINF, for its pieces: that is one station.
  const isStream = /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(t) || !/#EXTINF/i.test(t);
  const list = isStream ? [{ name: host, url, group: '', logo: '' }] : parseM3U(t).filter((s) => /^https?:\/\//i.test(s.url));
  const seen = new Set();
  return list.filter((s) => !seen.has(s.url) && seen.add(s.url)).slice(0, MAX_STATIONS);
}

module.exports = { ageOn, readLink, MAX_STATIONS };
