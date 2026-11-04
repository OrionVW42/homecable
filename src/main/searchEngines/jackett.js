// A connector for a Torznab server you run yourself (Jackett, Prowlarr or similar). It
// lists nothing of its own and is empty until you give it your server's address.
const CATS = { all: '', movies: '2000', tv: '5000', anime: '5070', music: '3000', games: '1000,4050', software: '4000', books: '7000,8000' };

module.exports = {
  name: 'Jackett / Prowlarr',
  url: '',
  about: 'A connector for a Torznab server you run yourself. It comes with no sources',
  version: '1.0',
  categories: ['all', 'movies', 'tv', 'anime', 'music', 'games', 'software', 'books'],
  options: [
    { key: 'url', label: 'Address', placeholder: 'http://127.0.0.1:9117 — or a full Torznab address', required: true },
    { key: 'apiKey', label: 'API key', placeholder: 'from its dashboard', secret: true, required: true },
    { key: 'indexers', label: 'Indexer', placeholder: 'all', required: false },
  ],
  async search(query, category, h) {
    const base = String(h.options.url || '').trim().replace(/\/+$/, '');
    const key = String(h.options.apiKey || '').trim();
    if (!base || !key) throw new Error('needs its address and API key — Search engines');
    const endpoint = /\/api\b/i.test(base) ? base : `${base}/api/v2.0/indexers/${encodeURIComponent(String(h.options.indexers || '').trim() || 'all')}/results/torznab/api`;
    const cats = CATS[category] || '';
    return this.parse(await h.text(`${endpoint}${endpoint.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(key)}&t=search&q=${encodeURIComponent(query)}${cats ? '&cat=' + cats : ''}&limit=100`), h);
  },
  parse(xml, h) {
    const err = /<error[^>]*code="(\d+)"[^>]*description="([^"]*)"/i.exec(xml);
    if (err) throw new Error(h.decode(err[2]) || `Torznab error ${err[1]}`);
    const tag = (s, t) => { const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i').exec(s); return m ? h.strip(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')) : ''; };
    const attr = (s, n) => { const m = new RegExp(`<torznab:attr\\s+name="${n}"\\s+value="([^"]*)"`, 'i').exec(s); return m ? h.decode(m[1]) : ''; };
    return h.all(xml, /<item>([\s\S]*?)<\/item>/gi).map(([, it]) => {
      const name = tag(it, 'title');
      const magnetUrl = attr(it, 'magneturl');
      const hash = attr(it, 'infohash');
      const link = magnetUrl || (hash && h.magnet(hash, name)) || tag(it, 'link') || (/<enclosure[^>]*url="([^"]+)"/i.exec(it) || [])[1] || '';
      const seeds = attr(it, 'seeders') === '' ? null : +attr(it, 'seeders');
      const peers = +attr(it, 'peers');
      return {
        name, link: h.decode(link), size: h.bytes(tag(it, 'size') || attr(it, 'size') || (/<enclosure[^>]*length="(\d+)"/i.exec(it) || [])[1]),
        seeds, leech: attr(it, 'leechers') !== '' ? +attr(it, 'leechers') : seeds != null && peers >= seeds ? peers - seeds : 0,
        descLink: tag(it, 'comments') || tag(it, 'guid'), pubDate: tag(it, 'pubDate'),
      };
    }).filter((r) => r.name && r.link);
  },
};
