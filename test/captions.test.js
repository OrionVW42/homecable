const test = require('node:test');
const assert = require('node:assert');
const { clean, wav } = require('../src/main/captions');

test('caption text drops what the model "hears" in silence and music', () => {
  assert.strictEqual(clean(' [BLANK_AUDIO] '), '');
  assert.strictEqual(clean('(music playing)'), '');
  assert.strictEqual(clean('Thank you.'), '');
  assert.strictEqual(clean('♪♪'), '');
  assert.strictEqual(clean(' Where are you going?\n I told you already. '), 'Where are you going? I told you already.');
  assert.strictEqual(clean('[MUSIC] He left (laughs) early.'), 'He left early.');
});

test('16 kHz mono WAV header', () => {
  const b = wav(Buffer.alloc(32000)); // 1 second
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(b.readUInt32LE(24), 16000);
  assert.strictEqual(b.readUInt16LE(22), 1);
  assert.strictEqual(b.readUInt32LE(40), 32000);
  assert.strictEqual(b.length, 44 + 32000);
});
