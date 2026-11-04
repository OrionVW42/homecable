// What a search engine gets to work with: a fetch that says it's HomeCable
// and a deadline (every request leaves through the pinned network interface, see
// pinSockets.js), text / json shortcuts that explain a refusal in plain words, and
// little parsers — HTML entities, "1.2 GB" → bytes, a magnet link from an info
// hash. Shared by the search process and the unit tests, so an engine's parser can
// be tried on a saved page without the internet.
const UA = 'HomeCable (torrent search)';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»' };

// HTML entities → characters.
const decode = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
// Tags out, entities decoded, whitespace folded.
const strip = (s) => decode(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
// "1.2 GB", "523.5 MiB", "700MB", 123456 → bytes (null when it can't tell).
const bytes = (s) => {
  if (typeof s === 'number') return isFinite(s) ? Math.round(s) : null;
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([kmgtp]i?b|bytes?|b)?/i.exec(String(s ?? ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const u = (m[2] || 'b')[0].toLowerCase();
  const mult = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 }[u] ?? 1;
  return isFinite(n) ? Math.round(n * mult) : null;
};
const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce', 'udp://explodie.org:6969/announce', 'udp://exodus.desync.com:6969/announce'];
// A magnet link from an info hash (hex or base32), with a name and trackers.
const magnet = (hash, name, trackers = TRACKERS) => {
  hash = String(hash || '').trim();
  if (!/^([0-9a-f]{40}|[a-z2-7]{32})$/i.test(hash)) return null;
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}${name ? '&dn=' + encodeURIComponent(name) : ''}${trackers.map((t) => '&tr=' + encodeURIComponent(t)).join('')}`;
};
// Every match of a global regex, as an array of match arrays.
const all = (s, re) => [...String(s ?? '').matchAll(re)];
// The text between two markers (first occurrence), or ''.
const between = (s, a, b) => { s = String(s ?? ''); const i = s.indexOf(a); if (i < 0) return ''; const j = b ? s.indexOf(b, i + a.length) : -1; return j < 0 ? s.slice(i + a.length) : s.slice(i + a.length, j); };

// A refusal, in words a person can act on.
function httpError(r, body) {
  const blocked = (r.status === 403 || r.status === 503) && /cf-chl|challenge-platform|Just a moment|cf-browser-verification|_cf_chl|ddos-guard|captcha/i.test(body || '');
  const e = new Error(blocked ? `the site doesn't allow apps to search it (${r.status})`
    : r.status === 404 ? 'the site answered 404 — its address may have changed'
      : r.status === 429 ? 'too many requests — the site asks for a break'
        : r.status === 401 ? 'the site refused the API key (401)'
          : `the site answered ${r.status}`);
  e.status = r.status; e.blocked = blocked;
  return e;
}
const netError = (e) => {
  const c = e?.cause?.code || e?.code || '';
  if (e?.name === 'TimeoutError' || c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'UND_ERR_HEADERS_TIMEOUT') return new Error('no answer in time');
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new Error('site not found (DNS) — is it still up, or is the network interface down?');
  if (c === 'ENETUNREACH' || c === 'EADDRNOTAVAIL' || c === 'EHOSTUNREACH') return new Error('unreachable through the torrent network interface');
  if (c === 'ECONNREFUSED') return new Error('connection refused — is it running at that address?');
  if (c === 'ECONNRESET' || c === 'UND_ERR_SOCKET') return new Error('the connection dropped');
  if (/CERT|certificate|SSL|TLS/i.test(c + ' ' + (e?.cause?.message || ''))) return new Error('bad certificate');
  return e instanceof Error ? e : new Error(String(e));
};

// The helper set one engine gets for one search.
function helpersFor({ signal = null, options = {}, category = 'all', log = () => {}, timeoutMs = 25000 } = {}) {
  const doFetch = async (url, init = {}) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    // Connection: close — a fresh socket every time, so a request can never ride a connection opened before the interface changed.
    const headers = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Connection: 'close', ...(init.headers || {}) };
    try { return await fetch(url, { redirect: 'follow', ...init, headers, signal: AbortSignal.any(signals) }); }
    catch (e) { if (signal?.aborted) throw e; throw netError(e); }
  };
  const text = async (url, init) => { const r = await doFetch(url, init); const t = await r.text(); if (!r.ok) throw httpError(r, t); return t; };
  const json = async (url, init = {}) => {
    const t = await text(url, { ...init, headers: { Accept: 'application/json,*/*;q=0.8', ...(init.headers || {}) } });
    try { return JSON.parse(t); } catch { throw new Error('the site did not answer with JSON'); }
  };
  return { fetch: doFetch, text, json, decode, strip, bytes, magnet, all, between, TRACKERS, UA, signal, options, category, log };
}

module.exports = { helpersFor, decode, strip, bytes, magnet, all, between, TRACKERS, UA };
