// Program guides (XMLTV) for live stations: "what's on" with real titles and
// times. Guide files are big, so they're streamed and only the programmes for
// stations in the lineup, in the next ~36 hours, are kept.
const zlib = require('zlib');
const { Readable } = require('stream');

// Free XMLTV guides by country (both keyed by ISO country code).
const COUNTRY_GUIDES = (cc) => [
  `https://epgshare01.online/epgshare01/epg_ripper_${cc.toUpperCase()}1.xml.gz`,
  `https://epg.pw/xmltv/epg_${cc.toUpperCase()}.xml.gz`,
];

const decode = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/\((?:\d{3,4}p|[^)]*)\)/g, '').replace(/\b(hd|sd|fhd|uhd|tv|channel|us|usa|east|west)\b/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
// XMLTV time: "20261031170000 +0000"
function xmltvTime(s) {
  const m = String(s).match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-]\d{4})?/);
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!m[7]) return t;
  const sign = m[7][0] === '-' ? -1 : 1;
  return t - sign * (+m[7].slice(1, 3) * 60 + +m[7].slice(3)) * 60e3;
}

// Stream one guide file; call back for channels and programmes as they appear.
async function streamGuide(url, { onChannel, onProgramme, signal }) {
  const res = await fetch(url, { signal, headers: { 'User-Agent': 'HomeCable' } });
  if (!res.ok || !res.body) throw new Error(`guide ${res.status}`);
  let stream = Readable.fromWeb(res.body);
  if (/\.gz(\?|$)/i.test(url) || /gzip/i.test(res.headers.get('content-type') || '')) stream = stream.pipe(zlib.createGunzip());
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk.toString('utf8');
    let cut = 0;
    for (const m of buf.matchAll(/<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>|<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
      if (m[1]) {
        const names = [...m[2].matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map((x) => decode(x[1]));
        onChannel?.(decode(m[1]), names);
      } else {
        const a = m[3];
        const ch = decode((a.match(/channel="([^"]+)"/) || [])[1] || '');
        const start = xmltvTime((a.match(/start="([^"]+)"/) || [])[1]);
        const stop = xmltvTime((a.match(/stop="([^"]+)"/) || [])[1]);
        const title = decode((m[4].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
        const sub = decode((m[4].match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/) || [])[1] || '');
        const desc = decode((m[4].match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || '').slice(0, 300);
        onProgramme?.({ ch, start, stop, title, sub, desc });
      }
      cut = m.index + m[0].length;
    }
    buf = buf.slice(cut);
    if (buf.length > 4e6) buf = buf.slice(-1e6); // malformed file guard
  }
}

// Build guides for the given stations. stations: [{ id, name, tvgId }]
// Returns { [stationId]: [{ start, end, title, sub, desc }] }
async function buildGuide(stations, urls, { from = Date.now() - 3 * 3600e3, to = Date.now() + 36 * 3600e3, log = () => {} } = {}) {
  const byTvg = new Map(), byName = new Map();
  for (const s of stations) {
    if (s.tvgId) byTvg.set(s.tvgId.toLowerCase(), s.id);
    const n = norm(s.name);
    if (n) byName.set(n, s.id);
  }
  const out = {};
  for (const url of urls) {
    // Guide channel id → our station, decided as the channel list streams by.
    const map = new Map();
    const want = stations.filter((s) => !out[s.id]?.length).length;
    if (!want) break;
    let kept = 0;
    try {
      await streamGuide(url, {
        signal: AbortSignal.timeout(180000),
        onChannel: (id, names) => {
          const hit = byTvg.get(id.toLowerCase()) || names.map((n) => byName.get(norm(n))).find(Boolean) || byName.get(norm(id.split('.')[0]));
          if (hit && !out[hit]?.length) map.set(id, hit);
        },
        onProgramme: (p) => {
          const sid = map.get(p.ch) || byTvg.get(p.ch.toLowerCase());
          if (!sid || !(p.stop > from && p.start < to) || !p.title) return;
          (out[sid] = out[sid] || []).push({ start: p.start, end: p.stop, title: p.title, sub: p.sub, desc: p.desc });
          kept++;
        },
      });
      log(`guide ${url}: ${map.size} stations matched, ${kept} programmes`);
    } catch (e) {
      log(`guide ${url}: ${e.message}`);
    }
  }
  for (const k in out) out[k].sort((a, b) => a.start - b.start);
  return out;
}

module.exports = { buildGuide, streamGuide, xmltvTime, COUNTRY_GUIDES, norm };
