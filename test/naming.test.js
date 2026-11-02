const test = require('node:test');
const assert = require('node:assert');
const { parsePath, showKey } = require('../src/main/naming');

const cases = [
  ['D:\\TV\\Breaking Bad\\Season 2\\Breaking.Bad.S02E05.720p.HDTV.x264-GRP.mkv', { show: 'Breaking Bad', season: 2, episode: 5 }],
  ['D:\\TV\\Friends\\Friends - 3x14 - The One with Phoebe.avi', { show: 'Friends', season: 3, episode: 14, title: 'The One with Phoebe' }],
  ['D:\\TV\\Buffy\\Season 1\\S01E03.mp4', { show: 'Buffy', season: 1, episode: 3 }],
  ['D:\\Anime\\Cowboy Bebop\\[Group] Cowboy Bebop - 07 [1080p].mkv', { show: 'Cowboy Bebop', episode: 7 }],
  ['D:\\Anime\\Cowboy Bebop\\07 - Heavy Metal Queen.mkv', { show: 'Cowboy Bebop', episode: 7, title: 'Heavy Metal Queen' }],
  ['D:\\Video\\TV\\Smallville\\1 Monday\\Smallville S03E04.mp4', { show: 'Smallville', season: 3, episode: 4 }],
  ['D:\\Movies\\The.Matrix.1999.1080p.BluRay.x264.mkv', { show: null, title: 'The Matrix', year: 1999, isMovieLike: true }],
  ['D:\\Movies\\Alien (1979)\\Alien (1979).mp4', { show: null, title: 'Alien', year: 1979 }],
  ['C:\\Users\\x\\Videos\\Show Name Season 2\\Episode 4.mkv', { show: 'Show Name', season: 2, episode: 4 }],
];
for (const [p, want] of cases) {
  test(p, () => {
    const got = parsePath(p);
    for (const k of Object.keys(want)) assert.strictEqual(got[k], want[k], `${k}: ${JSON.stringify(got)}`);
  });
}

test('showKey folds "The" and &', () => {
  assert.strictEqual(showKey('The Office'), showKey('office'));
  assert.strictEqual(showKey('Law & Order'), showKey('Law and Order'));
});
