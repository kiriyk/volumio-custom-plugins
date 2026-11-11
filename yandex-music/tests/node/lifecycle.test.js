'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Controller = require('../../index');

function environment() {
  const events = [];
  const router = { sharedVars: { get: () => 'ru' },
    volumioAddToBrowseSources: data => events.push(['add', data]),
    volumioRemoveToBrowseSources: name => events.push(['remove', name]),
    stateMachine: { getState: () => ({ service: 'mpd' }) },
    pluginManager: { getPlugin: () => ({ stop: async () => events.push(['mpd-stop']) }) },
    broadcastMessage: () => {}, pushToastMessage: () => {} };
  const api = { request: async (method, path) => path === '/health'
    ? { api_version: 1, ready: true } : { authenticated: false, user: null } };
  const service = { start: async () => events.push(['start']), stop: async () => events.push(['stop']) };
  return { controller: new Controller({ coreCommand: router, logger: { error: () => {} } }, { api, service }), events };
}

test('recording quality validates track URI and never broadcasts provider URLs', async () => {
  const { controller } = environment();
  const pushed = [], calls = [];
  controller.router.broadcastMessage = (event, data) => pushed.push({ event, data });
  controller.api = { request: async (method, path) => {
    calls.push([method,path]);
    return { recording_quality:{codec:'flac',basis:'available',url:'https://private.test/?token=hidden'} };
  } };
  await controller.getRecordingQuality({uri:'yandex_music/track/12%3A34'});
  await controller.getRecordingQuality({uri:'mnt/USB/test.flac'});
  assert.deepEqual(calls, [['GET','/v1/tracks/12%3A34/quality']]);
  assert.deepEqual(pushed, [{event:'pushRecordingQuality',data:{uri:'yandex_music/track/12%3A34',recordingQuality:{codec:'flac',basis:'available'}}}]);
});

test('signed-out source starts after service readiness and stop removes only itself', async () => {
  const env = environment();
  await env.controller.onStart();
  assert.deepEqual(env.events.map(event => event[0]), ['start', 'add']);
  assert.equal(env.events[1][1].plugin_name, 'yandex_music');
  await env.controller.onStop();
  assert.deepEqual(env.events.map(event => event[0]), ['start', 'add', 'remove', 'stop']);
});

test('native settings never populate saved OAuth token', async () => {
  const { controller } = environment();
  const config = await controller.getUIConfig();
  const token = config.sections.flatMap(section => section.content || []).find(item => item.id === 'token');
  assert.equal(token.value, '');
  assert.equal(token.type, 'password');
});

test('quality setting offers FLAC preference, strict FLAC and MP3', async () => {
  const { controller } = environment();
  const config = await controller.getUIConfig();
  const setting = config.sections.flatMap(section => section.content || []).find(item => item.id === 'quality');
  assert.equal(config.sections.find(section => section.id === 'audio').saveButton.label, 'Сохранить');
  assert.deepEqual(setting.options.map(option => option.value), ['auto', 'lossless', 'mp3']);
  assert.equal(setting.value.value, 'auto');
});

test('local file info broadcasts only measured data for the requested URI', async () => {
  const { controller } = environment();
  let pushed;
  controller.router.broadcastMessage = (event, data) => { pushed = { event, data }; };
  controller.localFiles = { get: async uri => ({ uri, size: 1024, bitrate: 320000 }) };
  await controller.getLocalFileInfo({ uri: 'mnt/USB/file.flac' });
  assert.deepEqual(pushed, { event: 'pushLocalFileInfo', data: { uri: 'mnt/USB/file.flac', size: 1024, bitrate: 320000 } });
});

test('quality request does not disclose a stale track after changing source', async () => {
  const { controller } = environment();
  let pushed;
  controller.router.broadcastMessage = (event, data) => { pushed = { event, data }; };
  controller.playback = { current: () => false, lastQuality: { uri: 'yandex_music/track/1', codec: 'mp3' } };
  await controller.getPlaybackQuality();
  assert.deepEqual(pushed, { event: 'pushYandexQuality', data: {} });
});

test('disabling during startup never registers a source afterwards', async () => {
  const env = environment();
  let finish;
  env.controller.service.start = () => new Promise(resolve => { finish = resolve; });
  const starting = env.controller.onStart();
  await env.controller.onStop();
  finish();
  await starting;
  assert.ok(!env.events.some(event => event[0] === 'add'));
});
