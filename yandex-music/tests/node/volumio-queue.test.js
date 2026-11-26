'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const VolumioQueue = require('../../lib/volumio-queue');
test('known Core notification failure is accepted only after verified clearing', async () => {
  let tracks = [{ uri: 'old' }];
  const sm = { getQueue: () => tracks, clearQueue: async () => { tracks = []; throw new TypeError('callback.apply is not a function'); } };
  await new VolumioQueue(sm).clear(); assert.deepEqual(tracks, []);
  tracks = [{ uri: 'user' }]; sm.clearQueue = async () => { throw new TypeError('callback.apply is not a function'); };
  await assert.rejects(new VolumioQueue(sm).clear(), /callback.apply/);
});
test('unknown queue errors stay errors even if queue happens to be empty', async () => {
  const sm = { getQueue: () => [], clearQueue: async () => { throw new Error('DISK_ERROR'); } };
  await assert.rejects(new VolumioQueue(sm).clear(), /DISK_ERROR/);
});
test('history removal uses native queue rejection rather than the hanging Core wrapper', async () => {
  const tracks = [{ uri: 'old' }, { uri: 'current' }]; let pushes = 0;
  const sm = { currentPosition: 1, getQueue: () => tracks, pushState: async () => { pushes++; },
    removeQueueItem: () => { throw new Error('hanging wrapper must not be used'); },
    playQueue: { removeQueueItem: async ({ value }) => { tracks.splice(value, 1); throw new Error('TypeError: callback.apply is not a function'); } } };
  await new VolumioQueue(sm).removePast(); assert.equal(sm.currentPosition, 0);
  assert.equal(tracks[0].uri, 'current'); assert.equal(pushes, 1);
});

test('history pruning does not wait for unrelated Core favourites work', async () => {
  const tracks = [{ uri: 'past' }, { uri: 'current' }];
  const sm = { currentPosition: 1, getQueue: () => tracks, pushState: () => new Promise(() => {}),
    playQueue: { removeQueueItem: async () => tracks.shift() } };
  await new VolumioQueue(sm).removePast();
  assert.equal(sm.currentPosition, 0); assert.equal(tracks.length, 1);
});
