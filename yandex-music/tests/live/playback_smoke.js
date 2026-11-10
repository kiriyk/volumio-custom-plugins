'use strict';
// Execute only with the owner's account and an initially stopped, empty queue.
const io = require('/volumio/node_modules/socket.io-client');
const net = require('node:net');
const socket = io.connect('http://127.0.0.1:3000', { reconnection: false });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function mpdState() {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: '127.0.0.1', port: 6600 });
    let buffer = ''; let greeted = false; let state;
    client.setTimeout(5000, () => { client.destroy(); reject(new Error('MPD status timed out')); });
    client.on('error', reject);
    client.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!greeted) { greeted = true; client.write('status\n'); }
        else if (line.startsWith('state: ')) state = line.slice(7);
        else if (line === 'OK') { client.end(); resolve(state); }
        else if (line.startsWith('ACK')) { client.end(); reject(new Error('MPD status rejected')); }
      }
    });
  });
}
const get = async name => {
  const response = await fetch('http://127.0.0.1:3000/api/v1/' + name);
  return response.json();
};
async function waitState(predicate, seconds = 20) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const state = await get('getState');
    if (predicate(state)) return state;
    await delay(250);
  }
  throw new Error('Playback state timed out');
}
const deadline = setTimeout(() => { console.error('Smoke timed out'); socket.emit('stop'); socket.close(); process.exit(1); }, 120000);
socket.once('connect', async () => {
  let initial;
  try {
    initial = await get('getState');
    const queue = await get('getQueue');
    if (initial.status !== 'stop' || queue.queue.length) throw new Error('Requires stopped empty queue');
    socket.emit('volume', Math.min(initial.volume, 15));
    await delay(300);
    const first = { service: 'yandex_music', uri: 'yandex_music/track/60426346' };
    const second = { service: 'yandex_music', uri: 'yandex_music/track/330765' };
    socket.emit('addPlay', first);
    let state = await waitState(state => state.status === 'play' && state.service === 'yandex_music');
    console.log(JSON.stringify({ check: 'play', status: state.status, duration: state.duration,
      service: state.service, trackType: state.trackType, uri: state.uri }));
    socket.emit('addToQueue', second);
    await delay(1200);
    socket.emit('pause');
    await waitState(state => state.status === 'pause');
    console.log(JSON.stringify({ check: 'pause', ok: true }));
    socket.emit('play');
    await waitState(state => state.status === 'play');
    socket.emit('seek', 30);
    state = await waitState(state => state.seek >= 29000);
    console.log(JSON.stringify({ check: 'resume_seek', seek: state.seek }));
    socket.emit('next');
    state = await waitState(state => state.status === 'play' && state.uri === second.uri);
    console.log(JSON.stringify({ check: 'next', uri: state.uri }));
    socket.emit('prev');
    await delay(300);
    socket.emit('prev');
    state = await waitState(state => state.status === 'play' && state.uri === first.uri);
    console.log(JSON.stringify({ check: 'previous', uri: state.uri }));
    socket.emit('seek', 183);
    state = await waitState(state => state.status === 'play' && state.uri === second.uri, 30);
    console.log(JSON.stringify({ check: 'natural_next', uri: state.uri }));
    socket.emit('stop'); await delay(500);
    const stopped = await mpdState();
    console.log(JSON.stringify({ check: 'mpd_stop', state: stopped }));
    if (stopped !== 'stop') throw new Error('MPD did not stop');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally {
    if (initial && initial.status === 'stop' && !(await get('getQueue')).queue.some(item => item.service !== 'yandex_music')) {
      socket.emit('stop'); await delay(350); socket.emit('clearQueue');
      socket.emit('volume', initial.volume); await delay(500);
    }
    clearTimeout(deadline); socket.close();
  }
});
