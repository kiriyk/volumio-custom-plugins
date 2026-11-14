'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const LocalStream = require('../../lib/local-stream');
const available = spawnSync('/usr/bin/ffmpeg', ['-version']).status === 0;

function command(args) {
  const result = spawnSync('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', ...args], {maxBuffer: 16 * 1024 * 1024});
  assert.equal(result.status, 0, String(result.stderr || result.error || 'ffmpeg failed'));
  return result.stdout;
}

async function fixture(t, rate = 96000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-extra-'));
  const root = path.join(dir, 'USB');
  const cacheDir = path.join(dir, 'cache');
  const bridge = new LocalStream({roots: [root], cacheDir});
  t.after(async () => { await bridge.close(); await fs.rm(dir, {recursive: true, force: true}); });
  await fs.mkdir(root);
  // Nonperiodic stereo 24-bit values expose shifted samples, truncation, and channel changes.
  const pcm = Buffer.alloc(rate * 3 * 2 * 3);
  let random = 123456789;
  for (let offset = 0; offset < pcm.length; offset += 3) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    pcm.writeIntLE((random >>> 8) - 8388608, offset, 3);
  }
  const raw = path.join(root, 'source.pcm');
  const flac = path.join(root, 'Музыка 音 100% +.flac');
  await fs.writeFile(raw, pcm);
  command(['-f', 's24le', '-ar', String(rate), '-ac', '2', '-i', raw, '-c:a', 'flac', flac]);
  await fs.writeFile(path.join(root, 'Альбом 100%.cue'),
    'FILE "Музыка 音 100% +.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:01:17\nTRACK 03 AUDIO\nINDEX 01 00:02:31\n');
  const uri = track => 'USB/' + encodeURIComponent('Альбом 100%.cue') + '/track000' + track;
  return {dir, cacheDir, bridge, pcm, uri};
}

function wavePcm(wave) {
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.toString('ascii', 8, 12), 'WAVE');
  for (let offset = 12; offset + 8 <= wave.length;) {
    const length = wave.readUInt32LE(offset + 4);
    if (wave.toString('ascii', offset, offset + 4) === 'data') return wave.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  assert.fail('WAVE data chunk missing');
}
async function request(url) {
  const response = await fetch(url);
  return {status: response.status, body: Buffer.from(await response.arrayBuffer())};
}

for (const rate of [44100, 96000]) {
  test('24-bit FLAC CUE segments preserve exact stereo PCM with a nonzero seek anchor at ' + rate + ' Hz', {skip: !available}, async t => {
    const {bridge, pcm, uri} = await fixture(t, rate);
    const boundaries = [0, 92 * rate / 75, 181 * rate / 75, 3 * rate];
    const segments = [];
    for (let track = 1; track <= 3; track++) {
      const result = await request(await bridge.urlFor(uri(track)));
      assert.equal(result.status, 200);
      const actual = wavePcm(result.body);
      const expected = pcm.subarray(boundaries[track - 1] * 6, boundaries[track] * 6);
      assert.equal(actual.length, expected.length);
      assert.deepEqual(actual, expected, 'track ' + track + ' PCM bytes');
      segments.push(actual);
    }
    assert.deepEqual(Buffer.concat(segments), pcm);
  });
}

test('cancellation after creating the output file rejects without a URL or cached audio', {skip: !available}, async t => {
  const {bridge, cacheDir, uri} = await fixture(t);
  let cancelled = false;
  const valid = () => {
    if (bridge.cue.directory && syncFs.readdirSync(bridge.cue.directory).some(file => file.endsWith('.wav'))) cancelled = true;
    return !cancelled;
  };
  await assert.rejects(bridge.urlFor(uri(2), {valid}));
  assert.equal(cancelled, true, 'cancellation must occur after decoder output creation');
  assert.equal(bridge.tickets.size, 0);
  assert.equal(bridge.server, null);
  const sessions = await fs.readdir(cacheDir);
  for (const session of sessions) assert.deepEqual(await fs.readdir(path.join(cacheDir, session)), []);
  // A cancelled request must not poison later preparations.
  assert.equal((await request(await bridge.urlFor(uri(2)))).status, 200);
});

test('the third CUE preparation evicts the oldest audio and its URL becomes unavailable', {skip: !available}, async t => {
  const {bridge, cacheDir, uri} = await fixture(t);
  const first = await bridge.urlFor(uri(1));
  const second = await bridge.urlFor(uri(2));
  const third = await bridge.urlFor(uri(3));
  assert.equal((await request(first)).status, 404);
  assert.equal((await request(second)).status, 200);
  assert.equal((await request(third)).status, 200);
  assert.equal((await fs.readdir(bridge.cue.directory)).filter(file => file.endsWith('.wav')).length, 2);
  await bridge.close();
  assert.deepEqual(await fs.readdir(cacheDir), []);
});
