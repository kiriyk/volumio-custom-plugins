'use strict';
// Optional real-core integration: no live Volumio instance or audio device is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const Q = require('kew');
const Manager = require('../../lib/manager');
const {XMLParser} = require('fast-xml-parser');
const source = process.env.VOLUMIO_STATEMACHINE_PATH || '/volumio/app/statemachine.js';

function loadCore() {
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module, exports: module.exports,
    require(id) {
      if (id === 'kew') return Q;
      if (id === './randomqueue') return function RandomQueue() {};
      throw Error('Unexpected core dependency: ' + id);
    },
    setTimeout: () => 0, clearTimeout() {}, Date, process: {env: {}}
  }, {filename: source});
  return module.exports;
}

async function until(check, label) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function renderer(t) {
  const played = [], actions = [], parser = new XMLParser({removeNSPrefix: true, parseTagValue: false});
  const state = {status: 'STOPPED', uri: '', position: '00:00:01.800'};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const action = String(req.headers.soapaction).split('#')[1].replace(/"$/, '');
      const args = parser.parse(Buffer.concat(chunks).toString()).Envelope.Body[action];
      actions.push(action);
      let result = '';
      if (action === 'Stop') state.status = 'STOPPED';
      if (action === 'SetAVTransportURI') state.uri = args.CurrentURI;
      if (action === 'Play') { state.status = 'PLAYING'; played.push(state.uri); }
      if (action === 'GetTransportInfo') result = '<CurrentTransportState>' + state.status + '</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>';
      if (action === 'GetPositionInfo') result = '<RelTime>' + state.position + '</RelTime><TrackDuration>00:00:02.000</TrackDuration>';
      res.writeHead(200, {'Content-Type': 'text/xml'});
      res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:' + action + 'Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' + result + '</u:' + action + 'Response></s:Body></s:Envelope>');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {state, played, actions, controlUrl: 'http://127.0.0.1:' + server.address().port + '/control'};
}

for (const service of ['mpd', 'qobuz_custom', 'yandex_music']) {
  test(`real Volumio play and syncState sequence three Album Player EOFs for ${service}`, {skip: !fs.existsSync(source)}, async t => {
    const remote = await renderer(t), Core = loadCore(), sm = Object.create(Core.prototype);
    const tracks = [0, 1, 2].map(index => ({uri: service + '/track/' + index, service, name: 'Track ' + index, duration: 2}));
    const urls = tracks.map((_, index) => 'http://127.0.0.1/track-' + index + '.wav');
    const errors = [], launches = [], checked = [];
    const log = {verbose() {}, info() {}};
    const plugins = {};
    const router = {logger: log, pushDebugConsoleMessage() {}, pushConsoleMessage() {},
      pushErrorConsoleMessage: error => errors.push(error), broadcastMessage() {},
      pluginManager: {getPlugin: (_category, name) => plugins[name]}};
    Object.assign(sm, {
      commandRouter: router, logger: log, currentPosition: 0, currentStatus: 'stop', currentSeek: 0,
      currentSongDuration: 0, currentRepeat: false, currentRepeatSingleSong: false, currentRandom: false,
      currentConsume: false, prefetchDone: false, askedForPrefetch: false, simulateStopStartDone: false,
      isVolatile: false, volatileState: null, isUpnp: false, isConsume: false, consumeState: {},
      runPlaybackTimer: false, playbackStart: Date.now(),
      playQueue: {arrayQueue: tracks, getTrack: index => tracks[index]},
      pushState: () => Q.resolve(), pushEmptyState: () => Q.resolve(),
      startPlaybackTimer() {
        this.runPlaybackTimer = true; this.playbackStart = Date.now();
        this.currentSongDuration = this.getTrack(this.currentPosition).duration * 1000;
        this.askedForPrefetch = false; this.prefetchDone = false; this.simulateStopStartDone = false;
        return Q.resolve();
      },
      stopPlaybackTimer() { this.runPlaybackTimer = false; this.currentSongDuration = 0; this.askedForPrefetch = false; return Q.resolve(); }
    });
    router.stateMachine = sm;
    const nativePrefetch = () => Q.resolve();
    const mpd = plugins.mpd = {prefetch: nativePrefetch, createMPDFile: callback => callback(),
      stop: async () => {}, pause: async () => {}, resume: async () => {}, seek: async () => {},
      clearAddPlayTrack: async () => {}, sendMpdCommand: async () => ({}), next: async () => {}, previous: async () => {}};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sequence-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const card = {key: 'test-card', label: 'No audio hardware', pcm: 'hw:unused'};
    const runtime = {devices: async () => [card], stopRenderer: async () => {},
      probe: async url => { checked.push(url); return {rate: 44100, bits: 16, channels: 2}; }, check: async () => {},
      endpoints: {controlUrl: remote.controlUrl}};
    const localStream = {urlFor: async uri => { launches.push(uri); return urls[tracks.findIndex(track => track.uri === uri)]; }, close: async () => {}};
    const manager = new Manager({router, runtime, localStream, stateDir: dir});
    await manager.start(); t.after(() => manager.close());
    manager.settings.managed = true; manager.settings.engine = 'album_player';
    manager.settings.device = {key: card.key, label: card.label};
    manager.configureRenderer = async () => {};
    // Opt-in negative control recreates the native MPD prefetch exposed before this fix.
    if (process.env.VOLUMIO_QUEUE_NATIVE_PREFETCH === '1') Object.defineProperty(mpd, 'prefetch', {configurable: true, value: nativePrefetch});
    if (service !== 'mpd') {
      const facade = manager.createTransport(service, error => errors.push(error));
      plugins[service] = {clearAddPlayTrack(track) {
        launches.push(track.uri);
        const index = sm.currentPosition;
        const valid = () => sm.currentPosition === index && sm.getTrack(index) === track;
        return facade.play(urls[index], track, valid).catch(error => errors.push(error));
      }};
    }

    assert.equal(sm.play, Core.prototype.play, 'queue launches must use the real core play method');
    assert.equal(sm.syncState, Core.prototype.syncState, 'EOF must pass through real core state handling');
    await sm.play();
    for (let index = 0; index < tracks.length; index++) {
      await until(() => remote.played.length === index + 1 && manager.active?.delegate?.session, 'renderer track ' + index);
      const transport = manager.active.delegate;
      clearTimeout(transport.timer); transport.timer = null;
      await transport.poll();
      assert.equal(sm.currentStatus, 'play');
      sm.currentSeek = 1800; sm.playbackStart = Date.now();
      sm.increasePlaybackTimer();
      assert.equal(sm.currentPosition, index, 'timer must retain the current track until actual renderer EOF');
      assert.equal(sm.prefetchDone, false);
      remote.state.status = 'STOPPED'; remote.state.position = '00:00:00.000';
      await transport.poll();
      // A repeated poll of the finished transport must not enqueue a duplicate.
      await transport.poll();
      if (index < tracks.length - 1) {
        await until(() => remote.played.length === index + 2, 'next track after EOF');
        assert.equal(sm.currentPosition, index + 1);
        remote.state.position = '00:00:01.800';
      }
    }
    await manager.chain;
    assert.deepEqual(remote.played, urls, 'all three tracks must play once in queue order');
    assert.deepEqual(launches, tracks.map(track => track.uri));
    assert.deepEqual(checked, urls, 'each track retains bypass format preflight');
    assert.deepEqual(errors, []);
    assert.equal(sm.currentStatus, 'stop');
    assert.equal(sm.currentPosition, 0, 'Volumio resets position when the queue ends');
    assert.equal(sm.runPlaybackTimer, false);
    assert.equal(remote.actions.filter(action => action === 'Play').length, 3);
  });
}
