const test = require('node:test');
const assert = require('node:assert');
const { Profiles, autoRating } = require('../src/main/profiles');
const mem = () => { const d = {}; return { read: (k, f) => d[k] ?? f, write: (k, v) => { d[k] = JSON.parse(JSON.stringify(v)); } }; };

test('locks: PIN, password and controller combo', () => {
  const p = new Profiles(mem());
  p.upsert({ name: 'Kid', level: 'kids', avatar: '🦄' });
  const kid = p.list.find((x) => x.name === 'Kid');
  p.setLock('me', 'pin', '1234');
  assert.ok(p.check('me', '1234'));
  assert.ok(p.check('me', ' 12-34 '), 'PIN ignores spaces/dashes');
  assert.ok(!p.check('me', '1235'));
  p.setLock('me', 'combo', ['UP', 'UP', 'DOWN', 'A']);
  assert.ok(p.check('me', 'up,up,down,a'));
  assert.ok(!p.check('me', ['UP', 'DOWN', 'UP', 'A']));
  p.setLock('me', 'password', 'Grandma99');
  assert.ok(p.check('me', 'Grandma99'));
  assert.ok(!p.check('me', 'grandma99'));
  assert.throws(() => p.setLock('me', 'pin', '12'), /4 to 8/);
  assert.throws(() => p.setLock('me', 'combo', ['A', 'B']), /4 button/);
  // Hashes never leave the module.
  assert.ok(!JSON.stringify(p.view()).includes(p.list[0].lock.hash));
  // Switching: unlocked kid profile is free; the locked adult needs the password.
  assert.ok(p.switchTo(kid.id));
  assert.ok(!p.isAdult());
  assert.ok(p.allows('all') && !p.allows('teen') && !p.allows('adult'));
  assert.ok(!p.switchTo('me', 'nope'));
  assert.ok(p.switchTo('me', 'Grandma99'));
  assert.ok(p.isAdult() && p.allows('adult'));
});

test('there is always a grown-up', () => {
  const p = new Profiles(mem());
  p.upsert({ id: 'me', name: 'Me', level: 'kids' });
  assert.strictEqual(p.list[0].level, 'adults');
  p.remove('me');
  assert.strictEqual(p.list.length, 1);
});

test('channel ratings are guessed sensibly', () => {
  const lib = { meta: { bluey: { genres: ['Children', 'Animation'] }, csi: { genres: ['Crime', 'Drama'] } } };
  assert.strictEqual(autoRating({ name: 'Kids', sources: [{ type: 'show', key: 'bluey' }] }, lib), 'all');
  assert.strictEqual(autoRating({ name: 'Crime', sources: [{ type: 'show', key: 'csi' }] }, lib), 'teen');
  assert.strictEqual(autoRating({ name: 'Toons', iptv: { group: 'Animation;Kids' } }, lib), 'all');
  assert.strictEqual(autoRating({ name: 'News 24', iptv: { group: 'News' } }, lib), 'teen');
  assert.strictEqual(autoRating({ name: 'Classic Cartoons', sources: [{ type: 'server', id: 'archive:classic_cartoons' }] }, lib), 'all');
});
