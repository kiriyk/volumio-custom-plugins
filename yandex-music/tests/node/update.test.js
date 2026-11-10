'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitUpdate, stageArchive } = require('../../scripts/update');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('update completion uses numeric progress instead of localized messages', async () => {
  const socket = new EventEmitter();
  const pending = waitUpdate(socket, { name: 'yandex_music', category: 'music_service' }, 1000);
  socket.emit('installPluginStatus', { progress: 100, message: 'Успешно обновлен плагин' });
  await pending;
});

test('update failure rejects and releases its status listener', async () => {
  const socket = new EventEmitter();
  const pending = waitUpdate(socket, { name: 'yandex_music', category: 'music_service' }, 1000);
  socket.emit('installPluginStatus', { progress: 0, message: 'Ошибка обновления' });
  await assert.rejects(pending, /Update failed/);
  assert.equal(socket.listenerCount('installPluginStatus'), 0);
});

test('release staging works across the separate data and tmp filesystems', context => {
  if (!fs.existsSync('/dev/shm') || fs.statSync('/dev/shm').dev === fs.statSync(os.tmpdir()).dev)
    return context.skip('Requires two filesystems');
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-release-'));
  const targetDir = fs.mkdtempSync('/dev/shm/ym-plugin-');
  try {
    const source = path.join(sourceDir, 'source.zip');
    const target = path.join(targetDir, 'target.zip');
    fs.writeFileSync(source, 'archive bytes');
    stageArchive(source, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'archive bytes');
    assert.equal(fs.existsSync(source), false);
  } finally {
    fs.rmSync(sourceDir, { recursive: true }); fs.rmSync(targetDir, { recursive: true });
  }
});
