'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalFileInfo } = require('../../lib/local-file-info');

test('returns size and measured bitrate only for files within mounted music roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-info-'));
  try {
    await fs.writeFile(path.join(root, 'track.flac'), Buffer.alloc(1234));
    const info = new LocalFileInfo({ roots: { USB: root }, probe: async () => 960000 });
    assert.deepEqual(await info.get('mnt/USB/track.flac'), { uri: 'mnt/USB/track.flac', size: 1234, bitrate: 960000 });
    assert.deepEqual(await info.get('music-library/USB/track.flac'), { uri: 'music-library/USB/track.flac', size: 1234, bitrate: 960000 });
    assert.equal(await info.get('mnt/USB/../outside'), null);
    await fs.symlink('/etc/passwd', path.join(root, 'escape.flac'));
    assert.equal(await info.get('mnt/USB/escape.flac'), null);
    assert.equal(await info.get('mnt/NAS/missing.flac'), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
