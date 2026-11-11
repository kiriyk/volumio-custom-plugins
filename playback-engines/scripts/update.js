'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function stageArchive(source, target) {
  // Volumio mounts /data and /tmp on different filesystems; rename cannot cross them.
  fs.copyFileSync(source, target);
  fs.unlinkSync(source);
}

function waitUpdate(socket, manifest, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); socket.removeListener('installPluginStatus', status);
      if (error) reject(error); else resolve();
    };
    const status = data => {
      if (data.progress === 100) finish();
      else if (data.progress === 0) finish(new Error('Update failed; check Volumio installation log'));
    };
    const timer = setTimeout(() => finish(new Error('Update timed out')), timeoutMs);
    socket.on('installPluginStatus', status);
    socket.emit('updatePlugin', { url: 'http://127.0.0.1:3000/plugin-serve/playback_engines.zip',
      category: manifest.category, name: manifest.name });
  });
}

async function main() {
  const folder = path.resolve(process.argv[2] || '.');
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json')));
  if (manifest.name !== 'playback_engines' || manifest.category !== 'audio_interface') throw new Error('Wrong plugin package');
  execFileSync('volumio', ['plugin', 'package'], { cwd: folder, stdio: 'inherit' });
  fs.mkdirSync('/tmp/plugins', { recursive: true });
  stageArchive(path.join(folder, 'playback_engines.zip'), '/tmp/plugins/playback_engines.zip');
  const io = require('/volumio/node_modules/socket.io-client');
  const socket = io.connect('http://127.0.0.1:3000', { reconnection: false });
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', () => reject(new Error('Volumio API is unavailable')));
    });
    await waitUpdate(socket, manifest);
    console.log('Playback Engines updated; saved profiles and renderer configuration were preserved. Restart Volumio to load the new plugin code.');
  } finally { socket.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { waitUpdate, stageArchive };
