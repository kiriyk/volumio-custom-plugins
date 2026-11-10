'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

async function probeFile(filename) {
  const { stdout } = await exec('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=bit_rate',
    '-of', 'default=noprint_wrappers=1:nokey=1', filename], { timeout: 10000, maxBuffer: 4096 });
  const bitrate = Number(stdout.trim());
  return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null;
}

class LocalFileInfo {
  constructor({ roots = { USB: '/mnt/USB', NAS: '/mnt/NAS', INTERNAL: '/mnt/INTERNAL' }, probe = probeFile } = {}) {
    this.roots = roots; this.probe = probe; this.cache = new Map(); this.active = 0; this.waiters = [];
  }
  async get(uri) {
    if (typeof uri !== 'string' || uri.length > 4096 || uri.includes('\0')) return null;
    const parts = uri.split('/');
    if (!['mnt', 'music-library'].includes(parts[0]) || !this.roots[parts[1]] || parts.length < 3 || parts.slice(2).some(p => !p || p === '.' || p === '..')) return null;
    const hit = this.cache.get(uri);
    if (hit && hit.expires > Date.now()) return hit.value;
    try {
      const base = await fs.realpath(this.roots[parts[1]]);
      const filename = await fs.realpath(path.join(base, ...parts.slice(2)));
      if (!filename.startsWith(base + path.sep)) return null;
      const stat = await fs.stat(filename);
      if (!stat.isFile()) return null;
      if (this.active >= 3) await new Promise(resolve => this.waiters.push(resolve));
      this.active++;
      let bitrate;
      try { bitrate = await this.probe(filename); } catch { bitrate = null; }
      finally { this.active--; this.waiters.shift()?.(); }
      const value = { uri, size: stat.size, bitrate };
      this.cache.set(uri, { value, expires: Date.now() + 300000 });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
      return value;
    } catch { return null; }
  }
}
module.exports = { LocalFileInfo };
