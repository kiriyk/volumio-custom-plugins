'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Q = require('/volumio/node_modules/kew');
const Core = require('/volumio/app/statemachine');
const base = '/tmp/albumplayer-transport-test';
const Api = require(base + '/code/qobuz/lib/api-client');
const Browse = require(base + '/code/qobuz/lib/browse');
const Playback = require(base + '/code/qobuz/lib/playback');
const { createTransport } = require(base + '/code/shared/playback');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kew(p) { const d = Q.defer(); Promise.resolve(p).then(v => d.resolve(v), e => d.reject(e)); return d.promise; }
async function until(predicate, label, ms = 30000) {
  fs.writeFileSync(base + '/phase.json', JSON.stringify({ label, at: new Date().toISOString() }));
  const start = Date.now();
  while (Date.now() - start < ms) { if (predicate()) return; await sleep(100); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  const summary = { isolatedCore: true, physicalOutput: false, controls: {}, errors: [] };
  const api = new Api({ key: fs.readFileSync('/data/configuration/music_service/qobuz_custom/api-key', 'utf8').trim() });
  // ALSA null does not impose a device clock. Pace HTTP input so a long track
  // cannot finish decoding while the test is sending pause/resume commands.
  const relay = http.createServer((req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: 17901, path: req.url,
      method: req.method, headers: req.headers.range ? { Range: req.headers.range } : {} }, async response => {
      res.writeHead(response.statusCode, response.headers);
      try {
        for await (const chunk of response) {
          if (res.destroyed) break;
          res.write(chunk);
          await sleep(chunk.length / 200);
        }
        res.end();
      } catch { res.destroy(); }
    });
    upstream.on('error', () => res.destroy()); res.on('close', () => upstream.destroy()); upstream.end();
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const relayPort = relay.address().port;
  const realStreamUrl = api.streamUrl.bind(api);
  api.streamUrl = (...args) => realStreamUrl(...args).replace(':17901/', ':' + relayPort + '/');
  const keyTrack = (await api.request('GET', '/v1/tracks/9140024')).items[0];
  const albumTracks = await new Browse(api).explode('qobuz_custom/album/' + keyTrack.album_id);
  const smoke = process.argv.includes('--smoke');
  const tracks = smoke ? albumTracks.slice(0, 2) : albumTracks;
  summary.smoke = smoke;
  assert.ok(tracks.length > 1);
  const states = [], launched = [];
  let playback, sm;
  const plugin = {};
  const router = {
    logger: { info() {}, error() {}, verbose() {}, debug() {}, warn() {} },
    pushConsoleMessage() {}, pushDebugConsoleMessage() {}, pushErrorConsoleMessage() {}, initPlayerControls() {},
    volumioretrievevolume: () => Q.resolve({ vol: 0, mute: false, disableVolumeControl: true }),
    volumioPushState: state => { states.push({ position: state.position, uri: state.uri, status: state.status }); return Q.resolve(); },
    volumioPushQueue: () => Q.resolve(), executeOnPlugin: (category, name, method) => method === 'getConfigParam' ? true : Q.resolve(),
    emitFavourites() {}, playListManager: { listFavourites: () => Q.resolve({ navigation: { lists: [{ items: [] }] } }) },
    addTracksForInfinityPlayback() {},
    pluginManager: { getPlugin: (category, name) => name === 'qobuz_custom' ? plugin : { stop: () => Q.resolve() } },
    getMusicPlugin: () => plugin,
    serviceStop: () => plugin.stop(), servicePause: () => plugin.pause(), serviceResume: () => plugin.resume(),
    serviceClearAddPlayTracks: () => plugin.clearAddPlayTrack(sm.getTrack(sm.currentPosition))
  };
  sm = new Core(router); await sleep(150);
  sm.playQueue.arrayQueue = tracks;
  summary.album = tracks[0].album; summary.queueLength = tracks.length;
  const onError = e => summary.errors.push(e.code || e.message);
  const transport = createTransport({ config: { engine: 'album_player', ...JSON.parse(fs.readFileSync(base + '/control.json')) },
    // Release of real MPD is deliberately stubbed: the renderer has no hardware in this test.
    mpd: { stop: async () => {} }, sm, service: 'qobuz_custom', onError });
  const observations = [];
  const call = transport.client.call.bind(transport.client);
  transport.client.call = async (...args) => {
    const control = !['GetTransportInfo', 'GetPositionInfo'].includes(args[0]);
    const start = Date.now();
    if (control) observations.push({ action: args[0], phase: 'request' });
    try {
      const result = await call(...args);
      observations.push({ action: args[0], phase: 'response', ms: Date.now() - start,
        ...Object.fromEntries(Object.entries(result).filter(([k]) => ['CurrentTransportState','CurrentTransportStatus','RelTime','TrackDuration'].includes(k))) });
      if (observations.length > 24) observations.splice(0, observations.length - 24);
      return result;
    } catch (error) {
      observations.push({ action: args[0], phase: 'failure', ms: Date.now() - start, code: error.code });
      throw error;
    }
  };
  playback = new Playback(api, {}, sm, onError, () => '27', transport);
  for (const method of ['pause', 'resume', 'stop', 'seek', 'previous', 'next']) plugin[method] = (...args) => kew(playback[method](...args));
  plugin.clearAddPlayTrack = track => { launched.push(track.uri); return kew(playback.clearAddPlayTrack(track)); };
  const playing = index => sm.currentPosition === index && transport.session?.track.uri === tracks[index].uri && transport.session.seenPlaying;
  try {
    await sm.play(0); await until(() => playing(0), 'first album track');
    summary.controls.play = true;
    await sm.pause(); await until(() => sm.getState().status === 'pause', 'pause');
    summary.controls.pause = true;
    await sm.play(); await until(() => sm.getState().status === 'play', 'resume');
    summary.controls.resume = true;
    await sm.seek(30); await sleep(700);
    assert.ok(transport.session.position >= 29000); summary.controls.seek = transport.session.position;
    sm.next(); await until(() => playing(1), 'manual next'); summary.controls.next = true;
    sm.previousTrackonPrev = true; sm.previous(); await until(() => playing(0), 'manual previous'); summary.controls.previous = true;
    for (let i = 0; i < tracks.length - 1; i++) {
      await until(() => playing(i), 'automatic track ' + i);
      await sm.seek(Math.max(0, tracks[i].duration - 1));
      await until(() => playing(i + 1), 'automatic transition ' + i);
    }
    summary.controls.automaticTransitions = tracks.length - 1;
    await sm.seek(Math.max(0, tracks.at(-1).duration - 1));
    await until(() => sm.currentStatus === 'stop' && !transport.session, 'album end');
    summary.controls.albumEnd = true;
    assert.deepEqual(summary.errors, []);
    summary.launchedTrackCount = launched.length;
    summary.passed = true;
  } catch (e) {
    summary.passed = false; summary.failure = e.message;
    summary.observations = observations;
    summary.diagnostic = { index: sm.currentPosition, coreStatus: sm.currentStatus, session: transport.session ? { seenPlaying: transport.session.seenPlaying, position: transport.session.position, duration: transport.session.duration } : null };
  } finally {
    await playback.stop().catch(() => {}); transport.close(); sm.stopPlaybackTimer();
    relay.closeAllConnections(); relay.close();
    fs.writeFileSync(base + (smoke ? '/queue-smoke.json' : '/queue-acceptance.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.passed) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e.code || e.name); process.exitCode = 1; });
