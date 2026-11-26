'use strict';
// Pi-only multi-client / manual queue check. Replaces the queue and plays at
// volume 6. Requires the settings backup from wave_smoke.js. Pass --browser-start to click Start
// in Artwork One instead of issuing startWave from this script.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const original = JSON.parse(fs.readFileSync('/data/wave-release-backup/rpip-wave-engine-before.json'));
const io = require('/volumio/node_modules/socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clients = [];
const connect = () => new Promise((resolve, reject) => {
  const socket = io('http://localhost:3000', { forceNew: true, reconnection: false });
  clients.push(socket); socket.on('pushYandexWave', state => { socket.wave = state; });
  socket.once('connect', () => resolve(socket)); socket.once('connect_error', reject);
});
const call = (socket, method, data = {}) => socket.emit('callMethod', { endpoint: 'music_service/yandex_music', method, data });
const get = async name => (await fetch('http://localhost:3000/api/v1/' + name)).json();
async function until(predicate, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const state = await get('getState'); if (await predicate(state)) return state; await sleep(200); }
  throw new Error('Timeout: ' + label);
}
(async () => {
  const a = await connect(), b = await connect();
  call(a, 'getWave'); call(b, 'getWave');
  await until(() => a.wave?.options && b.wave?.options, 'options');
  assert.equal((await get('getState')).status, 'stop');
  a.emit('volume', 6); await sleep(300);
  const activity = a.wave.options.activity.values[0].value;
  if (process.argv.includes('--browser-start')) console.log('READY: select first activity and press Start in Artwork One');
  else call(a, 'startWave', { selection: { activity } });
  let state = await until(s => s.status === 'play' && [a, b].every(c => c.wave?.active && c.wave.selection.activity === activity), 'applied settings on both clients');
  assert.deepEqual(a.wave.selection, b.wave.selection);
  const uri = state.uri, initial = (await get('getQueue')).queue.length;
  a.emit('addToQueue', { service: 'yandex_music', uri });
  await until(() => !a.wave.active && !b.wave.active, 'manual edit ends wave');
  state = await get('getState'); assert.equal(state.status, 'play'); assert.equal(state.uri, uri);
  const edited = (await get('getQueue')).queue.length; assert.equal(edited, initial + 1);
  await sleep(3000); assert.equal((await get('getQueue')).queue.length, edited);
  a.emit('stop'); await until(s => s.status === 'stop', 'native Stop');
  b.close(); const reconnected = await connect(); call(reconnected, 'getWave');
  await until(() => reconnected.wave?.selection.activity === activity, 'reconnect selection');
  assert.equal(reconnected.wave.active, false);
  console.log(JSON.stringify({ appliedSettings: true, twoClients: true, manualQueueEndsMode: true,
    playingTrackPreserved: true, refillStopped: true, nativeStop: true, reconnect: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => {
    const socket = clients.find(c => c.connected);
    if (socket) {
      socket.emit('stop'); await until(state => state.status === 'stop', 'cleanup Stop');
      for (const [method, volume] of [['saveMpd', original.custom.mpd.volume], ['saveAlbum', original.custom.album_player.volume]])
        socket.emit('callMethod', { endpoint: 'audio_interface/playback_engines', method, data: { volume } });
      await sleep(1000);
    }
    clients.forEach(c => c.close());
  });
