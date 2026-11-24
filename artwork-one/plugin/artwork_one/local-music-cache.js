'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;
const RETRY = 15 * 60 * 1000;
const FRESH = { found: 90 * DAY, notFound: DAY, temporaryError: RETRY };
const MIB = 1024 * 1024;
const DEFAULT_CACHE_MIB = 64;
const digest = data => createHash('sha256').update(data).digest('hex');

class LocalMusicCache {
  constructor(dir, { maxBytes = DEFAULT_CACHE_MIB * MIB, now = Date.now, onError = () => {} } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.now = now;
    this.onError = onError;
    this.inflight = new Map();
    this.writes = Promise.resolve();
    this.generation = 0;
  }

  result(key, lookup, { needsRefresh } = {}) {
    const id = digest(JSON.stringify([1, key]));
    if (this.inflight.has(id)) return this.inflight.get(id);
    const result = this.readThrough(id, lookup, this.generation, needsRefresh).finally(() => {
      if (this.inflight.get(id) === result) this.inflight.delete(id);
    });
    this.inflight.set(id, result);
    return result;
  }

  async readThrough(id, lookup, generation, needsRefresh) {
    await this.writes;
    const hit = await this.read(id);
    if (hit?.freshUntil > this.now() && (hit.result.retryAt || !needsRefresh?.(hit.result.value))) return hit.result;
    let result;
    let retryAt;
    try {
      const value = await lookup();
      result = value === null ? { status: 'notFound' } : { status: 'found', value };
    } catch (error) {
      this.onError(error, 'lookup');
      result = hit?.result.status === 'found' ? hit.result : { status: 'temporaryError' };
      const now = this.now();
      retryAt = Number.isFinite(error.retryAfter) ? Math.max(now + 1000, error.retryAfter) : now + RETRY;
      result = { ...result, retryAt };
    }
    await this.write(id, { result, freshUntil: retryAt ?? this.now() + FRESH[result.status] }, generation);
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

  enqueue(work) {
    const run = this.writes.then(work);
    this.writes = run.catch(() => {});
    return run;
  }

  write(id, data, generation) {
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
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
  }

  async entries(replacedId) {
    const names = await fs.readdir(this.dir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return Promise.all(names.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)
      && entry.name !== replacedId + '.json').map(async ({ name }) => {
      const file = path.join(this.dir, name);
      const stat = await fs.stat(file);
      return { file, size: stat.size, time: stat.mtimeMs };
    }));
  }

  usage() {
    return this.enqueue(async () => (await this.entries()).reduce((sum, entry) => sum + entry.size, 0));
  }

  resize(maxBytes) {
    return this.enqueue(async () => {
      await this.prune(undefined, 0, maxBytes);
      this.maxBytes = maxBytes;
    });
  }

  clear() {
    this.generation++;
    this.inflight.clear();
    return this.enqueue(async () => {
      for (const { file } of await this.entries()) await fs.rm(file, { force: true });
    });
  }

  async prune(replacedId, addedSize, limit = this.maxBytes) {
    const entries = await this.entries(replacedId);
    let used = entries.reduce((sum, entry) => sum + entry.size, addedSize);
    entries.sort((a, b) => a.time - b.time);
    for (const entry of entries) {
      if (used <= limit) break;
      await fs.rm(entry.file, { force: true });
      used -= entry.size;
    }
  }
}

module.exports = { LocalMusicCache, DEFAULT_CACHE_MIB, MIB, digest };
