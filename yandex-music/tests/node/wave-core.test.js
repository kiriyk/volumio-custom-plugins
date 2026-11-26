'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Q = require('kew');
const Wave = require('../../lib/wave'), Playback = require('../../lib/playback');
const { createTransport } = require('../../../shared/playback');
const source = process.env.VOLUMIO_STATEMACHINE_PATH || '/volumio/app/statemachine.js';
const wait = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert(Date.now() < deadline, 'Core/transport timed out'); await new Promise(r => setTimeout(r, 5)); }
};
for (const engine of ['mpd', 'album_player']) test(`wave passes three batches through real Core with ${engine}`, { skip: !fs.existsSync(source) }, async t => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module, exports: module.exports,
    require: id => id === 'kew' ? Q : function () {}, setTimeout, clearTimeout, Date, process: { env: {} } });
  const Core = module.exports, sm = Object.create(Core.prototype), callbacks = [], feedback = [], errors = [];
  const log = { verbose() {}, info() {}, error() {} }, plugins = {};
  const router = { logger: log, pushDebugConsoleMessage() {}, pushConsoleMessage() {}, pushErrorConsoleMessage: e => errors.push(e),
    broadcastMessage() {}, addCallback: (_, callback) => callbacks.push(callback), callbacks: { volumioPushState: callbacks },
    pluginManager: { getPlugin: (_, name) => plugins[name] }, getMusicPlugin: name => plugins[name],
    serviceStop: () => playback.stop(), servicePause: () => playback.pause(), serviceResume: () => playback.resume(),
    serviceClearAddPlayTracks: () => playback.clearAddPlayTrack(sm.getTrack(sm.currentPosition)), stateMachine: sm };
  const queue = { arrayQueue: [], getTrack(index) { return this.arrayQueue[index]; }, getQueue() { return this.arrayQueue; }, getTrackBlock() { return []; },
    addQueueItems(items) { this.arrayQueue.push(...items); return Q.resolve(); },
    clearPlayQueue() { this.arrayQueue = []; return Q.resolve(); },
    removeQueueItem({ value }) { this.arrayQueue.splice(value, 1); return Q.resolve(); } };
  Object.assign(sm, { commandRouter: router, logger: log, currentPosition: 0, currentStatus: 'stop', currentSeek: 0,
    currentSongDuration: 0, currentRepeat: false, currentRepeatSingleSong: false, currentRandom: false, currentConsume: false,
    prefetchDone: false, askedForPrefetch: false, simulateStopStartDone: false, isVolatile: false, volatileState: {},
    isUpnp: false, isConsume: false, consumeState: {}, playQueue: queue, randomQueue: { reset() {} },
    getState() { return { service: 'yandex_music', uri: queue.arrayQueue[this.currentPosition]?.uri,
      status: this.currentStatus, seek: this.currentSeek, random: this.currentRandom, repeat: this.currentRepeat }; },
    pushState() { for (const callback of callbacks) callback(this.getState()); return Q.resolve(); },
    pushEmptyState() { return this.pushState(); },
    startPlaybackTimer() { this.runPlaybackTimer = true; this.currentSongDuration = 2000; return Q.resolve(); },
    stopPlaybackTimer() { this.runPlaybackTimer = false; return Q.resolve(); }
  });
  delete sm.getState; // Exercise the actual Core consume snapshot, too.
  let next = 1, batches = 0, status = 'PLAYING';
  const api = { streamUrl: () => 'http://127.0.0.1/stream.mp3', request: async (_, route, body) => {
    if (route === '/v1/wave/start' || route === '/v1/wave/next') {
      batches++; return { id: 'local', selection: {}, items: Array.from({ length: 5 }, () => ({
        id: String(next++), available: true, artists: [], duration_ms: 2000 })) };
    }
    if (route === '/v1/playback/resolve') return { codec: 'mp3', path: '/stream/ticket' };
    if (route === '/v1/wave/event') feedback.push(body);
    return {};
  } };
  const mpd = plugins.mpd = { sendMpdCommand: async () => ({}), parseState: raw => ({ status: raw.state, seek: raw.seek, duration: 2 }),
    stop: async () => {}, pause: async () => {}, resume: async () => {}, seek: async () => {} };
  const wave = new Wave(api, router);
  const transport = createTransport({ config: { engine }, mpd, sm, service: 'yandex_music', onTrackEnd: track => wave.ended(track),
    onError: error => errors.push(error), pollMs: 60000,
    client: { call: async action => action === 'GetTransportInfo' ? { CurrentTransportState: status, CurrentTransportStatus: 'OK' } :
      action === 'GetPositionInfo' ? { RelTime: '00:00:01.800', TrackDuration: '00:00:02.000' } : {} } });
  const playback = new Playback(api, mpd, sm, e => errors.push(e), () => 'auto', transport);
  plugins.yandex_music = { clearAddPlayTrack: track => playback.clearAddPlayTrack(track) };
  t.after(async () => { transport.close(); await wave.close(); });
  async function playing() {
    await wait(() => playback.started && playback.track?.uri === queue.arrayQueue[sm.currentPosition]?.uri);
    if (engine === 'mpd') {
      const state = mpd.parseState({ state: 'play', seek: 1800 });
      await sm.syncState(state, 'mpd');
    } else { status = 'PLAYING'; await transport.poll(); await transport.poll(); }
    await wave.serial;
  }
  await wave.start({});
  for (let index = 0; index < 15; index++) {
    await playing(); assert.equal(wave.active, true, 'wave remains active at ' + index);
    const uri = playback.track.uri;
    if (engine === 'mpd') {
      const state = mpd.parseState({ state: 'stop', seek: 2000 });
      await sm.syncState(state, 'mpd');
    } else { status = 'STOPPED'; await transport.poll(); }
    await wave.feedback;
    assert.equal(feedback.filter(e => e.event === 'trackFinished' && e.track_id === uri.split('/').pop()).length, 1);
  }
  await playing(); await wave.stop();
  assert(batches >= 3); assert.equal(feedback.filter(e => e.event === 'trackFinished').length, 15);
  assert.deepEqual(errors, []); assert.equal(wave.active, false);
});
