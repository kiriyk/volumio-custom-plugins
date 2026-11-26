'use strict';
// Pi only. Save the queue/settings first; this deliberately plays recommendations.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const io = require('/volumio/node_modules/socket.io-client');
const socket = io('http://127.0.0.1:3000', { reconnection: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let wave, engines;
socket.on('pushYandexWave', state => { wave = state; });
socket.on('pushPlaybackEnginesState', state => { engines = state; });
const call = (endpoint, method, data = {}) => socket.emit('callMethod', { endpoint, method, data });
const yandex = (method, data) => call('music_service/yandex_music', method, data);
const get = async name => (await fetch('http://127.0.0.1:3000/api/v1/' + name)).json();
async function until(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const state = await get('getState'); if (await predicate(state)) return state; await sleep(250); }
  throw new Error('Timed out: ' + label + (wave?.error ? ' wave=' + wave.error : ''));
}
async function main() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timeout')), 10000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', () => { clearTimeout(timeout); reject(new Error('Socket connection failed')); });
  });
  call('audio_interface/playback_engines', 'getState');
  await until(() => engines?.ready, 'engine startup', 60000);
  const original = JSON.parse(fs.readFileSync('/data/wave-release-backup/rpip-wave-engine-before.json'));
  const engine = process.argv[2];
  assert(['mpd', 'album_player'].includes(engine));
  assert.equal((await get('getState')).status, 'stop');
  try {
    call('audio_interface/playback_engines', 'saveSelection', { engine, device: original.device.key,
      mpdMode: original.modes.mpd, albumMode: original.modes.album_player });
    await until(() => engines?.engine === engine && engines.ready, 'engine switch', 60000);
    socket.emit('volume', 6); await sleep(500);
    yandex('getWave'); await until(() => !!wave?.options && !wave.error, 'wave options');
    yandex('startWave', { selection: {} });
    let state = await until(s => s.status === 'play' && s.service === 'yandex_music' && wave?.active, 'first track');
    assert.equal(wave.error, null);
    socket.emit('pause'); await until(s => s.status === 'pause', 'pause'); assert(wave.active);
    await sleep(1000); socket.emit('play'); await until(s => s.status === 'play', 'resume');
    for (let index = 0; index < Number(process.argv[3] || 11); index++) {
      const uri = state.uri;
      assert(wave.active && !wave.error, 'active wave');
      assert(state.duration > 8, 'duration available');
      await sleep(1200);
      socket.emit('seek', Math.max(0, state.duration - 4));
      state = await until(s => s.status === 'play' && s.uri !== uri, 'EOF ' + index, 60000);
      const queue = (await get('getQueue')).queue;
      console.log(JSON.stringify({ engine, eof: index + 1, position: state.position,
        queue: queue.length, active: wave.active, observation: engines?.observation?.state }));
    }
    const beforeNext = state.uri;
    socket.emit('next'); state = await until(s => s.status === 'play' && s.uri !== beforeNext, 'Next');
    assert(wave.active, 'Next preserves wave');
    socket.emit('prev'); await sleep(300); socket.emit('prev');
    state = await until(s => s.status === 'play' && s.uri === beforeNext, 'Previous');
    assert(wave.active, 'Previous preserves wave');
    yandex('stopWave'); await until(s => s.status === 'stop' && !wave.active, 'Stop');
    console.log(JSON.stringify({ engine, checks: ['pause', 'resume', 'seek', `${Number(process.argv[3] || 11)} EOFs`, 'next', 'previous', 'stop'], ok: true }));
  } finally {
    yandex('stopWave'); await sleep(1200);
    call('audio_interface/playback_engines', 'saveMpd', { volume: original.custom.mpd.volume });
    call('audio_interface/playback_engines', 'saveAlbum', { volume: original.custom.album_player.volume });
    await sleep(1000); socket.close();
  }
}
const deadline = setTimeout(() => { console.error('wave hardware deadline'); yandex('stopWave'); socket.close(); process.exitCode = 1; }, 1200000);
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
