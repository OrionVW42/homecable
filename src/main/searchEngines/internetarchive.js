// The Internet Archive — only items marked public domain or Creative Commons. Every item
// has a .torrent, web-seeded by the Archive itself. The one source HomeCable ships with.
const FREE = 'licenseurl:(*publicdomain* OR *creativecommons*)';
const TYPES = { all: '(movies OR audio)', movies: 'movies', tv: 'movies', music: 'audio', software: 'software', books: 'texts' };

module.exports = {
  name: 'Internet Archive',
  url: 'https://archive.org',
  about: 'Only items marked public domain or Creative Commons',
  defaultOn: true,
  version: '1.0',
  categories: ['all', 'movies', 'tv', 'music', 'software', 'books'],
  async search(query, category, h) {
    const words = query.replace(/[()":\[\]{}^~\\]/g, ' ').trim();
    if (!words) return [];
    const q = `(${words}) AND ${FREE} AND mediatype:${TYPES[category] || TYPES.all}${category === 'tv' ? ' AND collection:(television OR tvarchive OR classic_tv OR tv)' : ''}`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=item_size&fl[]=publicdate&fl[]=downloads&fl[]=licenseurl&rows=60&sort[]=downloads+desc&output=json`;
    return this.parse(await h.json(url), h);
  },
  parse(j, h) {
    return (j?.response?.docs || []).filter((d) => d.identifier).map((d) => ({
      name: Array.isArray(d.title) ? d.title[0] : d.title || d.identifier, size: +d.item_size || null, seeds: null, leech: null,
      link: `https://archive.org/download/${d.identifier}/${d.identifier}_archive.torrent`, descLink: `https://archive.org/details/${d.identifier}`, pubDate: d.publicdate || null,
    }));
  },
};
