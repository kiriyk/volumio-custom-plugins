'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Wave = require('../../lib/wave');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  let queue = [{ uri: 'old' }], nextId = 1, delayed, batches = 0;
  const calls = [], events = [];
  const tracks = () => Array.from({ length: 5 }, () => ({ id: String(nextId++), available: true, artists: [], duration_ms: 10000 }));
  const sm = { currentPosition: 0, currentRandom: true, currentRepeat: true, currentRepeatSingleSong: true,
    getQueue: () => queue, getState: () => ({ service: 'yandex_music', uri: queue[sm.currentPosition]?.uri,
      status: 'play', seek: 0, position: sm.currentPosition }),
    setRandom: value => { sm.currentRandom = value; }, setRepeat: (value, single) => { sm.currentRepeat = value; sm.currentRepeatSingleSong = single; },
    next() {}, previous() {}, seek() {}, pause() {},
    stop: async () => calls.push('stop'), clearQueue: async () => { queue = []; },
    addQueueItems: async items => { queue.push(...items); }, play: async index => { if (index !== undefined) sm.currentPosition = index; },
    removeQueueItem: async () => { queue.shift(); sm.currentPosition--; }
  };
  sm.playQueue = { removeQueueItem: async () => { queue.shift(); } };
  sm.pushState = async () => {};
  const api = { request: async (_, path, body) => {
    calls.push(path);
    if (path === '/v1/wave/start') {
      if (delayed) await delayed;
      return { id: 'session' + ++batches, selection: body.selection, items: tracks() };
    }
    if (path === '/v1/wave/next') return { items: tracks() };
    if (path === '/v1/wave/event') events.push(body);
    return {};
  } };
  const router = { stateMachine: sm, callbacks: { volumioPushState: [] }, broadcastMessage() {},
    addCallback: (name, fn) => router.callbacks[name].push(fn) };
  const wave = new Wave(api, router); t.after(() => wave.close());
  return { wave, sm, api, calls, events, router, delay: value => { delayed = value; } };
}

test('first batch failure leaves old queue and playback intact', async t => {
  const { wave, sm, api, calls } = fixture(t);
  api.request = async () => { throw new Error('AUTH_REQUIRED'); };
  await wave.start({}); wave.observe(sm.getState());
  assert.deepEqual(sm.getQueue(), [{ uri: 'old' }]);
  assert.equal(calls.includes('stop'), false); assert.equal(wave.active, false);
});

test('stop invalidates pending start before changing queue', async t => {
  const { wave, sm, delay } = fixture(t);
  let resolve; delay(new Promise(r => { resolve = r; }));
  const start = wave.start({}); await tick(); const stop = wave.stop(false); resolve();
  await Promise.all([start, stop]);
  assert.deepEqual(sm.getQueue(), [{ uri: 'old' }]); assert.equal(wave.active, false);
});

test('refill at two remaining, bounded history, and manual queue edit ends mode', async t => {
  const { wave, sm, calls } = fixture(t); await wave.start({}); wave.observe(sm.getState()); await wave.serial;
  for (let i = 0; i < 8; i++) { sm.currentPosition = sm.getQueue().length - 3; await wave.check(); }
  assert(sm.currentPosition <= 20); assert(sm.getQueue().length <= 28);
  assert(calls.filter(p => p === '/v1/wave/next').length >= 3);
  sm.getQueue().push({ uri: 'manual' }); await wave.check();
  assert.equal(wave.active, false); assert.equal(sm.currentRandom, true); assert.equal(sm.currentRepeatSingleSong, true);
});

test('pause preserves mode; skips and natural ends emit one terminal event', async t => {
  const { wave, sm, events } = fixture(t); await wave.start({}); wave.observe(sm.getState());
  wave.observe({ ...sm.getState(), status: 'pause' }); assert.equal(wave.active, true);
  const old = sm.getState(); wave.ended({ uri: old.uri }); wave.ended({ uri: old.uri });
  sm.currentPosition++; wave.observe(sm.getState());
  sm.currentPosition++; wave.observe(sm.getState());
  await wave.feedback;
  assert.equal(events.filter(e => e.event === 'trackFinished').length, 1);
  assert.equal(events.filter(e => e.event === 'skip').length, 1);
  await wave.stop(); assert.equal(wave.active, false);
});

test('late refill cannot append to a user queue', async t => {
  const { wave, sm, api } = fixture(t); await wave.start({}); wave.observe(sm.getState()); await wave.serial;
  const original = api.request; let release;
  api.request = async (...args) => args[1] === '/v1/wave/next' ? new Promise(r => { release = r; }) : original(...args);
  sm.currentPosition = 2; const refill = wave.check(); await tick();
  sm.getQueue().push({ uri: 'manual' }); release({ items: [{ id: '100', artists: [] }] });
  await refill; await wave.check();
  assert.equal(sm.getQueue().at(-1).uri, 'manual'); assert.equal(wave.active, false);
});

test('listening time excludes pause and seek jumps', async t => {
  const { wave, sm } = fixture(t); await wave.start({}); wave.observe(sm.getState());
  wave.current.at -= 1000; wave.current.seek = 2000;
  wave.accountTime({ ...sm.getState(), seek: 3000 });
  assert(wave.current.seconds >= 1 && wave.current.seconds < 1.1);
  const played = wave.current.seconds;
  wave.current.at -= 30000; wave.current.playing = false;
  wave.accountTime({ ...sm.getState(), seek: 3000 });
  assert.equal(wave.current.seconds, played);
  wave.current.at -= 1000; wave.accountTime({ ...sm.getState(), seek: 100000 });
  assert.equal(wave.current.seconds, played);
});

test('shuffle and another source leave wave mode', async t => {
  const { wave, sm } = fixture(t); await wave.start({}); wave.observe(sm.getState());
  wave.observe({ ...sm.getState(), random: true }); await wave.serial;
  assert.equal(wave.active, false);
  await wave.start({}); wave.observe(sm.getState());
  wave.observe({ ...sm.getState(), service: 'webradio' }); await wave.serial;
  assert.equal(wave.active, false);
});

test('own queue notifications do not suppress confirmed playback feedback', async t => {
  const { wave, sm, events } = fixture(t); await wave.start({}); wave.observe(sm.getState());
  wave.mutating = true; sm.currentPosition++; wave.observe(sm.getState());
  wave.mutating = false; await wave.feedback;
  assert.equal(events.filter(event => event.event === 'trackStarted').length, 2);
  assert.equal(events.filter(event => event.event === 'skip').length, 1);
});

test('MPD preparation stop before the first confirmed play does not end wave', async t => {
  const { wave, sm } = fixture(t); await wave.start({});
  wave.observe({ ...sm.getState(), status: 'stop', service: 'mpd' });
  assert.equal(wave.active, true); assert.equal(wave.current, null);
  wave.observe(sm.getState()); assert(wave.current);
});

test('native Stop cancels a pending first batch', async t => {
  const { wave, sm, delay } = fixture(t); let resolve;
  delay(new Promise(r => { resolve = r; }));
  const start = wave.start({}); await tick();
  await sm.stop(); resolve(); await start; await wave.serial;
  assert.equal(wave.active, false); assert.deepEqual(sm.getQueue(), [{ uri: 'old' }]);
});

test('pause accounts for the last playing interval before excluding paused time', async t => {
  const { wave, sm } = fixture(t); await wave.start({}); wave.observe(sm.getState());
  wave.current.at -= 1000; wave.current.seek = 0;
  wave.accountTime({ ...sm.getState(), status: 'pause', seek: 1000 });
  assert(wave.current.seconds >= 1 && wave.current.seconds < 1.1);
  assert.equal(wave.current.playing, false);
});

test('stale consumed metadata during Next cannot cancel its navigation marker', async t => {
  const { wave, sm } = fixture(t); await wave.start({}); wave.observe(sm.getState());
  wave.current.seek = 2000; sm.next();
  wave.observe({ ...sm.getState(), seek: 0 });
  assert.equal(wave.navigating, true);
  wave.observe({ ...sm.getState(), status: 'stop' }); assert.equal(wave.active, true);
});

test('seek preserves listening before the command and excludes the position jump', async t => {
  const { wave, sm } = fixture(t); await wave.start({}); wave.observe(sm.getState());
  wave.current.at -= 1000;
  const getState = sm.getState; sm.getState = () => ({ ...getState(), seek: 1000 });
  sm.seek(100); const played = wave.current.seconds;
  assert(played >= 1 && played < 1.1);
  wave.observe({ ...sm.getState(), seek: 100000 }); assert.equal(wave.current.seconds, played);
});
