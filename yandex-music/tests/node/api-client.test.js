'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const ApiClient = require('../../lib/api-client');

test('local stream URI reports the actual codec to the installed MPD adapter', () => {
  const client = new ApiClient({ key: 'fixture' });
  assert.equal(client.streamUrl('/stream/opaque').split('.').at(-1), 'mp3');
  assert.equal(client.streamUrl('/stream/opaque', 'flac-mp4').split('.').at(-1), 'mp4');
  assert.equal(client.streamUrl('/stream/opaque', 'flac').split('.').at(-1), 'flac');
  assert.throws(() => client.streamUrl('/stream/opaque', 'unknown'));
  assert.throws(() => client.streamUrl('https://evil.example/audio.mp3'));
});

test('Node talks to the actual Python HTTP service with private auth and Unicode search', async () => {
  const root = path.resolve(__dirname, '../..');
  const child = spawn(process.env.YM_TEST_PYTHON || path.join(root, '.venv/bin/python'),
    ['tests/fixtures/api_server.py'], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service startup timed out: ${stderr}`)), 8000);
    child.stdout.once('data', data => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
  try {
    const client = new ApiClient({ key: 'fixture-key', port });
    assert.equal((await client.request('GET', '/health')).api_version, 1);
    await assert.rejects(new ApiClient({ key: 'wrong', port }).request('GET', '/v1/account'),
      error => error.code === 'ACCESS_DENIED');
    const account = await client.request('POST', '/v1/auth/token', { token: 'fixture-token' });
    assert.equal(account.user.name, 'Fixture listener');
    const result = await client.request('GET', '/v1/search?q=' + encodeURIComponent('Музыка'));
    assert.equal(result.items[0].title, 'Музыка');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
