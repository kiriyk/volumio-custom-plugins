'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {AplayerTransport, aplayerSource, aplayerProfile} = require('../../lib/aplayer');
const {defaults} = require('../../lib/profiles');
const {parseCue} = require('../../lib/cue');

async function fixture(t, duration = 1000) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aplayer-transport-'));
  const file = path.join(directory, 'source.wav');
  await fs.writeFile(file, '');
  const slot = path.join(directory, 'slot');
  const events = [], errors = [], commands = [];
  const state = {Scanning: false, Playing: false, Paused: false, Album: 0, Song: 0, Position: 0, LastError: ''};
  let stopped = 0;
  let wrongPath = false;
  const runtime = {
    slot,
    async clearSlot() {
      const files = await fs.readdir(slot);
      await Promise.all(files.map(name => fs.unlink(path.join(slot, name))));
    },
    async stop() { stopped++; },
    async request(name, params) {
      commands.push([name, params]);
      if (name === 'GetPlaylists') return {Drives: [{path: slot}]};
      if (name === 'GetAlbums') return {Songs: [{Songs: ['track'], SongsLen: [duration]}]};
      if (name === 'GetPath') {
        return {Path: wrongPath ? '/stale/wav' : path.join(slot, (await fs.readdir(slot))[0])};
      }
      if (name === 'State') return {...state};
      if (name === 'Play') state.Playing = true;
      if (name === 'Pause') state.Paused = !state.Paused;
      return {Result: 'OK'};
    }
  };
  const sm = {
    consumeState: {},
    async setConsumeUpdateService(name) { assert.equal(name, 'playback_engines'); },
    async syncState(state, owner) { events.push({state, owner}); }
  };
  const source = {
    suffix: '.wav',
    ticket: {file},
    open: async () => ({handle: await fs.open(file)})
  };
  const transport = new AplayerTransport({runtime, sm, service: 'mpd', verifyOutput: () => true,
    onError: error => errors.push(error.code)});
  t.after(async () => {
    transport.close();
    await transport.commands;
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {transport, source, state, events, errors, commands, setWrongPath: () => { wrongPath = true; },
    stopped: () => stopped, track: {uri: 'cue://USB/source.cue@0', trackType: 'wav'}};
}

function enableFakeTimers(t) {
  try {
    t.mock.timers.enable({apis: ['setTimeout']});
  } catch (error) {
    // Early Node 20 accepts an array instead of an options object.
    if (error.code !== 'ERR_INVALID_ARG_TYPE') throw error;
    t.mock.timers.enable(['setTimeout']);
  }
}

async function until(condition) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(condition(), 'condition was not reached');
}

test('APlayer keeps the Volumio URI, toggles pause idempotently and emits exactly one EOF', async t => {
  const e = await fixture(t);
  await e.transport.playLocal(e.source, e.track, () => true, () => true);
  assert.equal(e.events[0].state.uri, e.track.uri);
  assert.equal(e.events[0].state.duration, 1);
  await e.transport.pause();
  await e.transport.pause();
  await e.transport.seek(500);
  await e.transport.resume();
  await e.transport.resume();
  assert.equal(e.commands.filter(([command]) => command === 'Pause').length, 2);
  assert.deepEqual(e.commands.find(([command]) => command === 'Position')[1], {pos: 50});
  e.state.Position = 1070;
  e.state.Playing = false;
  await until(() => e.events.some(({state}) => state.status === 'stop'));
  assert.equal(e.events.filter(({state}) => state.status === 'stop').length, 1);
  assert.equal(e.stopped(), 1);
  assert.deepEqual(e.errors, []);
});

test('early or explicit stop does not advance Volumio’s queue', async t => {
  const e = await fixture(t);
  await e.transport.playLocal(e.source, e.track, () => true, () => true);
  e.state.Playing = false;
  e.state.Position = 120;
  await until(() => e.errors.length > 0);
  assert.deepEqual(e.errors, ['APLAYER_PLAYBACK_ERROR']);
  await e.transport.stop();
  assert.equal(e.stopped(), 1);
  assert.ok(e.events.every(({state}) => state.status === 'play'));
});

test('an obsolete scan cannot start a replacement track or report EOF', async t => {
  const e = await fixture(t);
  let active = true;
  e.setWrongPath();
  const starting = e.transport.playLocal(e.source, e.track, () => active, () => active);
  await until(() => e.commands.some(([name]) => name === 'GetPath'));
  active = false;
  assert.equal(await starting, false);
  await e.transport.stop();
  assert.ok(e.commands.every(([name]) => name !== 'Play'));
  assert.deepEqual(e.events, []);
});

test('source resolves both raw CUE URI forms by ordinal, independent of declared TRACK number', async () => {
  const cue = [
    'FILE "first.wav" WAVE', 'TRACK 03 AUDIO', 'INDEX 01 00:00:00',
    'TRACK 04 AUDIO', 'INDEX 01 00:01:00',
    'FILE "second.wav" WAVE', 'TRACK 05 AUDIO', 'INDEX 01 00:00:00'
  ].join('\n');
  const selected = [];
  const stream = {
    cue: {prepare: async (_stream, file, ordinal, _valid, options) => {
      selected.push([file, parseCue(cue, ordinal, options)]);
      return {file: '/private/segment.wav'};
    }},
    openFile: async () => ({handle: {close: async () => {}}})
  };
  await aplayerSource(stream, 'cue://USB/Тест @ 100%.cue@1', () => true);
  await aplayerSource(stream, 'music-library/USB/Тест @ 100%.cue/track0003', () => true);
  assert.deepEqual(selected, [
    ['USB/Тест @ 100%.cue', {file: 'first.wav', startFrame: 75, endFrame: null}],
    ['music-library/USB/Тест @ 100%.cue', {file: 'second.wav', startFrame: 0, endFrame: null}]
  ]);
});

test('DSD bypass chooses native output and its PCM converter stays disabled', () => {
  const profile = defaults().custom.album_player;
  const source = {encoding: 'dsd', rate: 352800, channels: 2};
  assert.equal(aplayerProfile(profile, true, source).patch.dop_mode, 2);
  assert.equal(aplayerProfile(profile, false, source).patch.dsd_vol, 0);
  assert.equal(aplayerProfile({...profile, dsdMode: 1}, false, source).patch.enable_dsd, 0);
  assert.throws(() => aplayerProfile({...profile, dsdMode: 1, volumeEnabled: true}, false, source),
    {code: 'APLAYER_DSD_PROCESSING_UNAVAILABLE'});
});

test('a confirmed 100 ms track can end with APlayer’s final position cached at 80 ms', async t => {
  const e = await fixture(t, 100);
  enableFakeTimers(t);
  e.state.Position = 20;
  await e.transport.playLocal(e.source, e.track, () => true, () => true);
  e.state.Position = 80;
  t.mock.timers.tick(5);
  await e.transport.commands;
  assert.equal(e.events.at(-1).state.seek, 80);
  assert.equal(e.events.at(-1).state.status, 'play');
  e.state.Playing = false;
  t.mock.timers.tick(5);
  await e.transport.commands;
  assert.equal(e.events.filter(({state}) => state.status === 'stop').length, 1);
  assert.deepEqual(e.errors, []);
});

test('a 100 ms track stopped at 40 ms reports an error without publishing EOF', async t => {
  const e = await fixture(t, 100);
  enableFakeTimers(t);
  e.state.Position = 40;
  await e.transport.playLocal(e.source, e.track, () => true, () => true);
  e.state.Playing = false;
  t.mock.timers.tick(5);
  await e.transport.commands;
  assert.deepEqual(e.errors, ['APLAYER_PLAYBACK_ERROR']);
  assert.equal(e.events.filter(({state}) => state.status === 'stop').length, 0);
});

test('a zero position is never accepted as EOF, even for a one-millisecond track', async t => {
  const e = await fixture(t, 1);
  enableFakeTimers(t);
  await e.transport.playLocal(e.source, e.track, () => true, () => true);
  e.state.Playing = false;
  t.mock.timers.tick(5);
  await e.transport.commands;
  assert.deepEqual(e.errors, ['APLAYER_PLAYBACK_ERROR']);
  assert.equal(e.events.filter(({state}) => state.status === 'stop').length, 0);
});

test('concurrent native shutdowns share one unit stop and wait for slot cleanup', async () => {
  const AplayerRuntime = require('../../lib/aplayer-runtime');
  const runtime = new AplayerRuntime({stateDir:'/unused'});
  runtime.requested = true;
  runtime.pid = 123;
  let stops = 0, release;
  runtime.systemctl = async () => { stops++; };
  runtime.clearSlot = () => new Promise(resolve => { release = resolve; });
  const first = runtime.stop();
  await Promise.resolve();
  const second = runtime.stop();
  assert.equal(first, second);
  assert.equal(stops, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(runtime.pid, null);
  assert.equal(runtime.stopping, null);
});
