'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Playback = require('../../lib/playback');

test('selected transport receives resolved URL and keeps ownership after pause', async () => {
  let valid, owns; const received = [], errors = [];
  const transport = { play: async (url, track, current, owner) => { received.push([url, track]); valid = current; owns = owner; return true; }, activate: async () => {}, pause: async () => {}, resume: async () => {}, seek: async ms => received.push(ms), stop: async () => {}, close: () => {} };
  const track = { service: 'yandex_music', uri: 'yandex_music/track/42', duration: 247 };
  const sm = { getTrack: () => track };
  const p = new Playback({ request: async () => ({ path: '/stream/ticket', codec: 'flac' }), streamUrl: path => `http://127.0.0.1:17899${path}` }, {}, sm, e => errors.push(e), undefined, transport);
  await p.clearAddPlayTrack(track);
  assert.equal(received[0][0], 'http://127.0.0.1:17899/stream/ticket'); assert.equal(received[0][1].trackType, 'flac');
  await p.pause(); assert.equal(valid(), false); assert.equal(owns(), true);
  await p.seek(10500); assert.equal(received.at(-1), 10500);
  await p.stop(); assert.equal(owns(), false); assert.deepEqual(errors, []);
});

test('failed renderer launch cannot report successful quality', async () => {
  const errors = [], track = { service: 'yandex_music', uri: 'yandex_music/track/42' };
  const p = new Playback({ request: async () => ({ path: '/stream/ticket', codec: 'flac' }), streamUrl: p => p }, {}, { getTrack: () => track }, e => errors.push(e), undefined,
    { play: async () => { throw Object.assign(new Error('ENGINE_UNAVAILABLE'), { code: 'ENGINE_UNAVAILABLE' }); } });
  await p.clearAddPlayTrack(track);
  assert.equal(p.lastQuality, null); assert.equal(errors[0].code, 'ENGINE_UNAVAILABLE');
});
