'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const LocalStream = require('../../lib/local-stream');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-stream-'));
  const root = path.join(dir, 'USB');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'Музыка 100%.flac'), '0123456789');
  await fs.writeFile(path.join(dir, 'secret.flac'), 'private');
  const bridge = new LocalStream({roots: [root]});
  t.after(async () => { await bridge.close(); await fs.rm(dir, {recursive: true, force: true}); });
  return {dir, root, bridge};
}
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('resolves supported library paths into opaque loopback URLs and streams Unicode names', async t => {
  const {root, bridge} = await fixture(t);
  await bridge.start();
  for (const uri of ['music-library/USB/Музыка%20100%25.flac', 'USB/Музыка%20100%25.flac', 'mnt/USB/Музыка%20100%25.flac', '/mnt/USB/Музыка%20100%25.flac', path.join(root, 'Музыка%20100%25.flac')]) {
    const url = await bridge.urlFor(uri);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.match(new URL(url).pathname, /^\/[a-f0-9]{48}\.flac$/);
    const result = await request(url);
    assert.equal(result.status, 200);
    assert.equal(result.body, '0123456789');
    assert.equal(result.headers['content-type'], 'audio/flac');
    assert.equal(result.headers['content-length'], '10');
    assert.equal(result.headers['accept-ranges'], 'bytes');
  }
});

test('supports GET and HEAD seek ranges, rejects malformed or unsatisfiable ranges', async t => {
  const {bridge} = await fixture(t);
  const url = await bridge.urlFor('USB/Музыка%20100%25.flac');
  for (const [range, body, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10']]) {
    const result = await request(url, {headers: {Range: range}});
    assert.equal(result.status, 206);
    assert.equal(result.body, body);
    assert.equal(result.headers['content-range'], contentRange);
    assert.equal(result.headers['content-length'], String(body.length));
    const head = await request(url, {method: 'HEAD', headers: {Range: range}});
    assert.equal(head.status, 206);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], String(body.length));
  }
  for (const range of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=1-2,4-5', 'nope', 'bytes=9007199254740993-']) {
    const result = await request(url, {headers: {Range: range}});
    assert.equal(result.status, 416, range);
    assert.equal(result.headers['content-range'], 'bytes */10');
  }
  assert.equal((await request(url, {method: 'HEAD'})).body, '');
  assert.equal((await request(url, {method: 'POST'})).status, 405);
});

test('rejects traversal, symlink escapes, directories and unsupported protocols', async t => {
  const {dir, root, bridge} = await fixture(t);
  await fs.symlink(path.join(dir, 'secret.flac'), path.join(root, 'escape.flac'));
  await fs.mkdir(path.join(root, 'folder'));
  for (const uri of ['USB/../secret.flac', 'USB/%2e%2e/secret.flac', 'USB/%252e%252e/secret.flac', 'USB/escape.flac', 'USB/folder', 'cue://USB/a.flac', 'file:///mnt/USB/a.flac', 'https://example.com/a.flac', path.join(dir, 'secret.flac'), 'USB/%00.flac']) {
    await assert.rejects(bridge.urlFor(uri), undefined, uri);
  }
});

test('revalidates tickets after symlink replacement and does not disclose filesystem paths', async t => {
  const {dir, root, bridge} = await fixture(t);
  const url = await bridge.urlFor('USB/Музыка%20100%25.flac');
  const file = path.join(root, 'Музыка 100%.flac');
  await fs.unlink(file);
  await fs.symlink(path.join(dir, 'secret.flac'), file);
  const result = await request(url);
  assert.equal(result.status, 404);
  assert.equal(result.body.includes(dir), false);
  assert.equal(result.body.includes('private'), false);
});

test('bounds ticket lifetime and revokes all URLs when closed', async t => {
  const {bridge} = await fixture(t);
  const first = await bridge.urlFor('USB/Музыка%20100%25.flac');
  let last;
  for (let n = 0; n < 256; n++) last = await bridge.urlFor('USB/Музыка%20100%25.flac');
  assert.equal((await request(first)).status, 404);
  assert.equal((await request(last)).status, 200);
  await bridge.close();
  await bridge.close();
  await assert.rejects(bridge.urlFor('USB/Музыка%20100%25.flac'));
  await assert.rejects(request(last));
});

test('client disconnect does not prevent subsequent streams or shutdown', async t => {
  const {root, bridge} = await fixture(t);
  await fs.writeFile(path.join(root, 'large.wav'), Buffer.alloc(8 * 1024 * 1024, 65));
  const url = await bridge.urlFor('USB/large.wav');
  await new Promise((resolve, reject) => {
    const req = http.get(url, res => { res.once('data', () => { res.destroy(); resolve(); }); });
    req.on('error', reject);
  });
  const seek = await request(url, {headers: {Range: 'bytes=8388600-'}});
  assert.equal(seek.status, 206);
  assert.equal(seek.body, 'AAAAAAAA');
  await bridge.close();
});


test('empty files remain streamable and empty seek ranges are unsatisfiable', async t => {
  const {root, bridge} = await fixture(t);
  await fs.writeFile(path.join(root, 'empty.wav'), '');
  const url = await bridge.urlFor('USB/empty.wav');
  const full = await request(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-length'], '0');
  assert.equal(full.body, '');
  const range = await request(url, {headers: {Range: 'bytes=0-'}});
  assert.equal(range.status, 416);
  assert.equal(range.headers['content-range'], 'bytes */0');
  const unknown = await request(url.replace(/\/[a-f0-9]{48}\.wav$/, '/unknown.wav'));
  assert.equal(unknown.status, 404);
});
