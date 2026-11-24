'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StreamQuality } = require('../stream-quality');

test('stream probe is shared across tickets for the same representation', async () => {
  const cache = new StreamQuality();
  const urls = [];
  const probe = async url => {
    urls.push(url);
    return { sampleRate: 44100, channels: 2 };
  };
  const result = { sampleRate: 44100, channels: 2 };
  assert.deepEqual(await Promise.all([
    cache.measure('qobuz/42/6', 'first-ticket', probe),
    cache.measure('qobuz/42/6', 'second-ticket', probe)
  ]), [result, result]);
  assert.deepEqual(await cache.measure('qobuz/42/6', 'third-ticket', probe), result);
  assert.deepEqual(await cache.measure('qobuz/42/27', 'hi-res-ticket', probe), result);
  assert.deepEqual(urls, ['first-ticket', 'hi-res-ticket']);
});

test('failed probes release the in-flight request and can be retried', async () => {
  const cache = new StreamQuality();
  await assert.rejects(cache.measure('yandex/4/flac', 'old-ticket', async () => {
    throw new Error('expired ticket');
  }), /expired ticket/);
  assert.deepEqual(await cache.measure('yandex/4/flac', 'new-ticket', async () => ({ bitDepth: 16 })),
    { bitDepth: 16 });
});
