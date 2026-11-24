'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;
const RETRY = 15 * 60 * 1000;
const FRESH = { found: 30 * DAY, notFound: DAY, temporaryError: RETRY };
const MIB = 1024 * 1024;
const digest = data => createHash('sha256').update(data).digest('hex');

class LocalMusicCache {
  constructor(dir, { maxBytes = 64 * MIB, now = Date.now, onError = () => {} } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.now = now;
    this.onError = onError;
    this.inflight = new Map();
    this.writes = Promise.resolve();
  }

  result(key, lookup) {
    const id = digest(JSON.stringify([1, key]));
    if (this.inflight.has(id)) return this.inflight.get(id);
    const result = this.readThrough(id, lookup).finally(() => this.inflight.delete(id));
    this.inflight.set(id, result);
    return result;
  }

  async readThrough(id, lookup) {
    const hit = await this.read(id);
    if (hit?.freshUntil > this.now()) return hit.result;
    let result;
    let retryAt;
    try {
      const value = await lookup();
      result = value === null ? { status: 'notFound' } : { status: 'found', value };
    } catch (error) {
      this.onError(error, 'lookup');
      result = hit?.result.status === 'found' ? hit.result : { status: 'temporaryError' };
      retryAt = Math.max(this.now() + RETRY, Number(error.retryAfter) || 0);
      result = { ...result, retryAt };
    }
    await this.write(id, { result, freshUntil: retryAt ?? this.now() + FRESH[result.status] });
    return result;
  }

  async read(id) {
    const file = path.join(this.dir, id + '.json');
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!FRESH[data.result?.status] || !Number.isFinite(data.freshUntil)) throw new Error('invalid cache entry');
      const now = new Date(this.now());
      await fs.utimes(file, now, now);
      return data;
    } catch (error) {
      if (error.code !== 'ENOENT') this.onError(error, 'read');
      return null;
    }
  }

  write(id, data) {
    const run = this.writes.then(async () => {
      const json = JSON.stringify(data);
      const size = Buffer.byteLength(json);
      if (size > this.maxBytes) return;
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.prune(id, size);
      const target = path.join(this.dir, id + '.json');
      const temp = target + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temp, json, { mode: 0o600 });
        const now = new Date(this.now());
        await fs.utimes(temp, now, now);
        await fs.rename(temp, target);
      } finally {
        await fs.rm(temp, { force: true });
      }
    }).catch(error => this.onError(error, 'write'));
    this.writes = run;
    return run;
  }

  async prune(replacedId, addedSize) {
    let used = addedSize;
    const entries = [];
    for (const name of await fs.readdir(this.dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name) || name === replacedId + '.json') continue;
      const file = path.join(this.dir, name);
      const stat = await fs.stat(file);
      used += stat.size;
      entries.push({ file, size: stat.size, time: stat.mtimeMs });
    }
    entries.sort((a, b) => a.time - b.time);
    for (const entry of entries) {
      if (used <= this.maxBytes) break;
      await fs.rm(entry.file, { force: true });
      used -= entry.size;
    }
  }
}

module.exports = { LocalMusicCache, digest };
