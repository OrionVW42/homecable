const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { importLegacySchedule, parsePyLiteral } = require('../src/main/legacyImport');

test('parses python literals', () => {
  const v = parsePyLiteral("{'a': [1, 2.5, True, None, 'x\\\\y'], 0.5: {'q': False}}");
  assert.deepStrictEqual(v.get('a'), [1, 2.5, true, null, 'x\\y']);
  assert.strictEqual(v.get(0.5).get('q'), false);
});

test('imports the real VideoApp schedule', () => {
  const { blocks, folders } = importLegacySchedule(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-data.txt'), 'utf8'));
  assert.ok(blocks.length > 50, 'blocks ' + blocks.length);
  const buffy = blocks.find((b) => b.name === 'Buffy');
  assert.ok(buffy, 'has Buffy');
  assert.strictEqual(buffy.sources[0].path, 'D:\\Video\\TV\\Buffy\\1 Monday');
  // Sleep music runs 00:30-07:30 on Monday as one merged block.
  const sleep = blocks.find((b) => b.name === 'Sleep' && b.days.includes(1));
  assert.strictEqual(sleep.start, '00:30');
  assert.strictEqual(sleep.order, 'shuffle');
  const outer = blocks.find((b) => b.name === 'The Outer Limits' && b.days.includes(1));
  assert.strictEqual(outer.startAt, 28);
  assert.ok(folders.includes('D:\\Video\\TV'), folders.join());
  // Every half hour of the week is covered exactly once.
  let mins = 0;
  for (const b of blocks) {
    const [sh, sm] = b.start.split(':').map(Number);
    const [eh, em] = b.end.split(':').map(Number);
    let d = eh * 60 + em - (sh * 60 + sm);
    if (d <= 0) d += 1440;
    mins += d * b.days.length;
  }
  assert.strictEqual(mins, 7 * 24 * 60);
});
