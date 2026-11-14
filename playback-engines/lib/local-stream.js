'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const CueStream = require('./cue-stream');
const {pipeline} = require('stream');

const MAX_TICKETS = 256;
const MIME = {'.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff'};
const within = (root, file) => file.startsWith(root + path.sep);

function decodePath(uri) {
  if (typeof uri !== 'string' || !uri || /^[a-z][a-z0-9+.-]*:/i.test(uri)) throw new Error('Unsupported local URI');
  let decoded;
  try { decoded = decodeURIComponent(uri); } catch (_) { throw new Error('Invalid local URI'); }
  // Resolve exactly one encoding layer, but reject hidden traversal at any layer.
  let safety = decoded;
  for (let n = 0; n < 8; n++) {
    if (safety.includes('\0') || safety.includes('\\') || safety.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid local URI');
    if (!/%[0-9a-f]{2}/i.test(safety)) break;
    let next;
    try { next = decodeURIComponent(safety); } catch (_) { break; }
    if (next === safety) break;
    safety = next;
    if (n === 7) throw new Error('Invalid local URI');
  }
  return decoded;
}

function rangeFor(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = match[1] === '' ? null : Number(match[1]);
  const last = match[2] === '' ? null : Number(match[2]);
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last > 0 ? {start: Math.max(0, size - last), end: size - 1} : null;
  if (first >= size || (last !== null && last < first)) return null;
  return {start: first, end: last === null ? size - 1 : Math.min(last, size - 1)};
}

class LocalStream {
  constructor({roots = ['/mnt/USB', '/mnt/NAS', '/mnt/INTERNAL'], port = 0, cacheDir = '/data/configuration/audio_interface/playback_engines/cue-cache'} = {}) {
    this.cue = new CueStream(cacheDir);
    this.roots = roots.map(root => path.resolve(root));
    this.port = port;
    this.tickets = new Map();
    this.sockets = new Set();
    this.closed = false;
    this.server = null;
    this.starting = null;
  }

  async start() {
    if (this.closed) throw new Error('Local stream is closed');
    if (this.starting) return this.starting;
    this.server = http.createServer((req, res) => {
      this.serve(req, res).catch(() => {
        if (!res.headersSent) { res.writeHead(404); res.end('Not found'); }
        else res.destroy();
      });
    });
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.starting = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    return this.starting;
  }

  async resolveFile(uri) {
    let decoded = decodePath(uri);
    let candidate;
    if (this.roots.some(root => within(root, decoded))) candidate = decoded;
    else {
      decoded = decoded.replace(/^music-library\//, '').replace(/^\/?mnt\//, '');
      const root = this.roots.find(item => decoded.startsWith(path.basename(item) + '/'));
      if (!root) throw new Error('Local file is unavailable');
      candidate = path.join(root, decoded.slice(path.basename(root).length + 1));
    }
    const real = await fsp.realpath(candidate);
    const roots = await Promise.all(this.roots.map(root => fsp.realpath(root).catch(() => null)));
    if (!roots.some(root => root && within(root, real))) throw new Error('Local file is unavailable');
    return {file: real, roots: roots.filter(Boolean)};
  }

  async openFile(ticket) {
    const real = await fsp.realpath(ticket.file);
    if (!ticket.roots.some(root => within(root, real))) throw new Error('Local file is unavailable');
    const handle = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      // Validate the opened inode too: a parent directory could change during open.
      const opened = await fsp.realpath('/proc/self/fd/' + handle.fd);
      if (!stat.isFile() || !ticket.roots.some(root => within(root, opened))) throw new Error('Local file is unavailable');
      return {handle, stat};
    } catch (error) { await handle.close(); throw error; }
  }

  async urlFor(uri, {valid = () => true} = {}) {
    if (this.closed) throw new Error('Local stream is closed');
    let ticket;
    try {
      const cue = /^(.*\.cue)\/track([0-9]+)$/i.exec(decodePath(uri));
      ticket = cue ? await this.cue.prepare(this, cue[1], 'track' + cue[2], valid) : await this.resolveFile(uri);
      const {handle} = await this.openFile(ticket);
      await handle.close();
    } catch (_) { throw new Error('Local file is unavailable or unsupported'); }
    await this.start();
    if (this.closed) throw new Error('Local stream is closed');
    const ext = path.extname(ticket.file).toLowerCase();
    const suffix = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
    const token = crypto.randomBytes(24).toString('hex') + suffix;
    this.tickets.set('/' + token, ticket);
    while (this.tickets.size > MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value);
    return 'http://127.0.0.1:' + this.server.address().port + '/' + token;
  }

  async serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {Allow: 'GET, HEAD'}); res.end(); return;
    }
    const ticket = this.tickets.get(req.url);
    if (this.closed || !ticket) { res.writeHead(404); res.end('Not found'); return; }
    const {handle, stat} = await this.openFile(ticket);
    let handedToStream = false;
    try {
      if (res.destroyed) return;
      const headers = {'Accept-Ranges': 'bytes', 'Content-Type': MIME[path.extname(ticket.file).toLowerCase()] || 'application/octet-stream'};
      let range;
      if (req.headers.range !== undefined) {
        range = rangeFor(req.headers.range, stat.size);
        if (!range) {
          res.writeHead(416, {'Content-Range': 'bytes */' + stat.size, 'Content-Length': '0', 'Accept-Ranges': 'bytes'});
          res.end(); return;
        }
        headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + stat.size;
      }
      headers['Content-Length'] = String(range ? range.end - range.start + 1 : stat.size);
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || stat.size === 0) { res.end(); return; }
      const stream = fs.createReadStream(null, {fd: handle.fd, autoClose: false, ...(range || {})});
      handedToStream = true;
      // pipeline applies backpressure and destroys the source after client aborts.
      pipeline(stream, res, () => { handle.close().catch(() => {}); });
    } finally {
      if (!handedToStream) await handle.close();
    }
  }

  async close() {
    this.closed = true;
    this.tickets.clear();
    await this.cue.close();
    if (!this.server) return;
    const server = this.server;
    if (this.starting) await this.starting.catch(() => {});
    await new Promise(resolve => {
      server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
    });
  }
}
module.exports = LocalStream;
module.exports.LocalStream = LocalStream;
