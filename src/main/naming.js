// Turns file paths into show / season / episode / movie metadata. Pure — no I/O.
const path = require('path');

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'f4v', 'webm', 'mpg', 'mpeg', 'mpe', 'm2v', 'ts', 'm2ts', 'mts', 'tp', 'vob', 'ogv', 'ogm', '3gp', '3g2', 'divx', 'xvid', 'rm', 'rmvb', 'asf', 'mxf', 'dv', 'mk3d', 'qt', 'y4m', 'nut', 'wtv', 'dvr-ms', 'evo', 'amv', 'h264', 'hevc', '264', '265']);
const AUDIO_EXT = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'aiff', 'aif', 'ape', 'alac', 'mka', 'wv', 'ac3', 'dts', 'mpc', 'tta']);

function extOf(file) { return path.extname(file).slice(1).toLowerCase(); }
function mediaType(file) {
  const e = extOf(file);
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return null;
}

// Junk that release groups put in file names.
const JUNK = /\b(480p|576p|720p|1080p|1080i|2160p|4k|uhd|hdr10?|dv|hdtv|web-?dl|web-?rip|webrip|bluray|blu-ray|bdrip|brrip|dvdrip|dvd|dvdscr|remux|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|aac(2\.0)?|ac3|eac3|ddp?5\.1|dts(-hd)?|truehd|atmos|10bit|8bit|proper|repack|internal|extended|unrated|remastered|multi|dual[- ]audio|subbed|dubbed|nf|amzn|hulu|dsnp|hmax|atvp)\b.*$/i;

function clean(s) {
  return s
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')        // [Group] {tags}
    .replace(/[._]+/g, ' ')
    .replace(JUNK, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s*[-–]\s*$/, '')
    .replace(/^\s*[-–]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function showKey(name) {
  return name.toLowerCase().replace(/^the\s+/, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

const DAY_DIR = /^\d?\s*(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?$/i;
// Folder names that are containers rather than a show's name.
const GENERIC_DIR = /^(season|series|staffel|saison|temporada|s)\s*\d+|^(specials?|extras?|disc\s*\d+|cd\s*\d+|dvd\s*\d*|part\s*\d+|vol(ume)?\s*\d+|video|videos|movies?|films?|tv|tv shows?|shows?|series|media|downloads?|complete|torrents?|new folder|anime|cartoons?|kids|documentar(y|ies)|music|music videos|\d+)$/i;

function seasonFromDir(dir) {
  const m = dir.match(/^(?:season|series|staffel|saison|temporada|s)\s*(\d+)/i);
  return m ? +m[1] : null;
}

function parsePath(file) {
  const ext = extOf(file);
  const base = path.basename(file, path.extname(file));
  const dirs = path.dirname(file).split(/[\\/]/).filter(Boolean);
  const res = { title: clean(base) || base, show: null, season: null, episode: null, year: null, isMovieLike: false };

  // Pick the nearest folder that names the show (skip "Season 2", "1 Monday", "Disc 1").
  let dirShow = null, dirSeason = null;
  for (let i = dirs.length - 1; i >= 0 && i >= dirs.length - 4; i--) {
    const d = dirs[i];
    const s = seasonFromDir(d);
    if (s != null) { dirSeason = dirSeason ?? s; continue; }
    if (DAY_DIR.test(d) || GENERIC_DIR.test(d) || /^[a-z]:$/i.test(d)) continue;
    // "Show Name Season 1" / "Show.S01.1080p"
    const inline = d.match(/^(.*?)[\s._-]+(?:season[\s._-]*(\d+)|s(\d{1,2}))(?:\b|[\s._-])/i);
    if (inline && clean(inline[1])) { dirShow = clean(inline[1]); dirSeason = dirSeason ?? +(inline[2] || inline[3]); break; }
    dirShow = clean(d.replace(/\(\d{4}\)/, '')) || null;
    break;
  }

  let m = base.match(/^(.*?)[\s._\-\[(]*[Ss](\d{1,3})[\s._-]*[Ee][Pp]?(\d{1,4})(?:[-Ee]+\d{1,4})?(.*)$/)
       || base.match(/^(.*?)[\s._\-\[(]*(\d{1,2})x(\d{2,3})(.*)$/);
  if (m) {
    res.show = clean(m[1]) || dirShow;
    res.season = +m[2];
    res.episode = +m[3];
    const rest = clean(m[4].replace(/^[\s._\-)\]]+/, ''));
    res.title = rest || `Episode ${res.episode}`;
  } else if ((m = base.match(/^(.*?)\b(?:ep(?:isode)?|e)[\s._-]*(\d{1,4})\b(.*)$/i)) && (clean(m[1]) || dirShow)) {
    res.show = clean(m[1]) || dirShow;
    res.season = dirSeason ?? 1;
    res.episode = +m[2];
    res.title = clean(m[3]) || `Episode ${res.episode}`;
  } else if ((m = base.match(/^(.*?)(?:^|[\s._-])(\d{1,4})(?:[\s._-]+(.*))?$/)) && dirShow && !/\b(19|20)\d{2}\b/.test(base)
             && (!clean(m[1]) || showKey(clean(m[1])) === showKey(dirShow))) {
    // "01 - Pilot.mkv" / "Show - 12.mkv" inside a show folder (common for anime)
    res.show = dirShow;
    res.season = dirSeason ?? 1;
    res.episode = +m[2];
    res.title = clean(m[3] || '') || `Episode ${res.episode}`;
  }

  const y = base.match(/^(.*?)[\s._(\[]+((?:19|20)\d{2})(?:[\s._)\]]|$)/);
  if (!res.show && y && clean(y[1])) {
    res.year = +y[2];
    res.title = clean(y[1]);
    res.isMovieLike = true;
  } else if (!res.show) {
    const dy = dirs.length && dirs[dirs.length - 1].match(/^(.*?)[\s._(\[]+((?:19|20)\d{2})(?:[\s._)\]]|$)/);
    if (dy) { res.year = +dy[2]; res.isMovieLike = true; }
  }
  res.dirShow = dirShow;
  res.dirSeason = dirSeason;
  res.ext = ext;
  return res;
}

// Natural sort so "Ep 2" < "Ep 10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function naturalCompare(a, b) { return collator.compare(a, b); }

module.exports = { parsePath, mediaType, showKey, clean, naturalCompare, VIDEO_EXT, AUDIO_EXT, DAY_DIR };
