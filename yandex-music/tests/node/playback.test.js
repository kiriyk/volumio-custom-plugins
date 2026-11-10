'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Playback = require('../../lib/playback');

function environment(api) {
  const calls = [];
  const sm = { getState: () => ({ service: 'yandex_music' }),
    setConsumeUpdateService: (...args) => { calls.push(['consume', ...args]); return Promise.resolve(); } };
  const mpd = { sendMpdCommand: async (command, args) => { calls.push([command, args]); },
    pause: async () => calls.push(['pause']), resume: async () => calls.push(['resume']),
    stop: async () => calls.push(['stop']), seek: async position => calls.push(['seek', position]) };
  const errors = [];
  return { playback: new Playback(api, mpd, sm, error => errors.push(error)), calls, sm, errors };
}
const track = { uri: 'yandex_music/track/12', service: 'yandex_music', duration: 120 };

test('resolved local stream is played via MPD with metadata consume mode', async () => {
  const env = environment({ request: async () => ({ path: '/stream/ticket', codec: 'mp3', bitrate: 320 }),
    streamUrl: path => `http://127.0.0.1:17899${path}` });
  await env.playback.clearAddPlayTrack(track);
  assert.ok(env.calls.some(call => call[0].startsWith('add "http://127.0.0.1:17899/stream/ticket')));
  assert.deepEqual(env.calls.find(call => call[0] === 'consume'), ['consume', 'mpd', true, false]);
  assert.equal(env.calls.at(-1)[0], 'play');
  assert.equal(track.uri, 'yandex_music/track/12');
});

test('reports the actual codec for the current resolved Yandex track', async () => {
  const events = [];
  const env = environment({ request: async () => ({ path: '/stream/ticket', codec: 'flac-mp4', bitrate: 0 }),
    streamUrl: path => `http://127.0.0.1:17899${path}` });
  env.playback.onQuality = info => events.push(info);
  await env.playback.clearAddPlayTrack(track);
  assert.deepEqual(events.at(-1), { uri: track.uri, codec: 'flac-mp4' });
});

test('reports measured audio format only while the same track is current', async () => {
  const events = [];
  const env = environment({ request: async () => ({ path: '/stream/ticket', codec: 'flac-mp4', bitrate: 0 }),
    streamUrl: path => `http://127.0.0.1:17899${path}` });
  env.playback.onQuality = info => events.push(info);
  env.playback.probeQuality = async () => ({ sampleRate: 44100, bitDepth: 16 });
  await env.playback.clearAddPlayTrack(track);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.at(-1), { uri: track.uri, codec: 'flac-mp4', sampleRate: 44100, bitDepth: 16 });
});

test('stop suppresses a delayed resolution', async () => {
  let resolve;
  const env = environment({ request: () => new Promise(done => { resolve = done; }) });
  const pending = env.playback.clearAddPlayTrack(track);
  await env.playback.stop();
  resolve({ path: '/stream/stale' });
  await pending;
  assert.ok(!env.calls.some(call => call[0] === 'play'));
});

test('changing source suppresses a delayed resolution', async () => {
  let resolve;
  const env = environment({ request: () => new Promise(done => { resolve = done; }) });
  const pending = env.playback.clearAddPlayTrack(track);
  env.sm.getState = () => ({ service: 'mpd' });
  resolve({ path: '/stream/stale' });
  await pending;
  assert.ok(!env.calls.some(call => call[0] === 'play'));
});

test('resolver errors are handled even when Core does not await its promise', async () => {
  const env = environment({ request: async () => { throw new Error('AUTH_REQUIRED'); } });
  await env.playback.clearAddPlayTrack(track);
  assert.equal(env.errors.length, 1);
  assert.ok(!env.calls.some(call => call[0] === 'play'));
});

test('seek preserves millisecond contract', async () => {
  const env = environment({});
  await env.playback.seek(10500);
  assert.deepEqual(env.calls.at(-1), ['seek', 10500]);
});

test('volatile playback by another source is not owned even with a Yandex queue item', () => {
  const env = environment({});
  env.sm.isVolatile = true;
  env.sm.volatileService = 'spotify';
  env.sm.getTrack = () => track;
  env.playback.track = track;
  assert.equal(env.playback.current(), false);
});

test('queued controls do not change MPD after another source becomes active', async () => {
  for (const action of ['stop', 'pause', 'resume', 'seek']) {
    const env = environment({});
    let release;
    env.playback.serial = new Promise(resolve => { release = resolve; });
    env.playback.started = true;
    const pending = env.playback[action](10500);
    env.sm.getState = () => ({ service: 'mpd' });
    release();
    await pending;
    assert.deepEqual(env.calls, [], action);
  }
});

test('previous leaves consume mode before asking Volumio to navigate the queue', async () => {
  const env = environment({});
  env.sm.previous = () => env.calls.push(['previous']);
  await env.playback.previous();
  assert.deepEqual(env.calls, [['consume', undefined], ['previous']]);
});

test('stop reaches MPD for a real queue item that includes its stable URI', async () => {
  const env = environment({});
  env.sm.getTrack = () => track;
  env.playback.track = track;
  env.playback.started = true;
  await env.playback.stop();
  assert.ok(env.calls.some(call => call[0] === 'stop'));
});
