'use strict';
const http = require('node:http');

class ApiError extends Error {
  constructor(code = 'SERVICE_UNAVAILABLE') { super(code); this.code = code; }
}

class ApiClient {
  constructor({ key, port = 17901, timeout = 65000 }) {
    this.key = key; this.port = port; this.timeout = timeout;
  }
  streamUrl(path, codec = 'mp3') {
    if (!/^\/stream\/[A-Za-z0-9_-]+$/.test(path)) throw new ApiError('UNAVAILABLE');
    const extension = { mp3: 'mp3', flac: 'flac', 'flac-mp4': 'mp4' }[codec];
    if (!extension) throw new ApiError('UNAVAILABLE');
    // Core 4.239 derives trackType from the last dot-separated URI suffix.
    return `http://127.0.0.1:${this.port}${path}?format=.${extension}`;
  }
  request(method, path, body) {
    if (!path.startsWith('/') || path.startsWith('//')) return Promise.reject(new ApiError('BAD_REQUEST'));
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: this.port, path, method,
        headers: { 'X-API-Key': this.key, ...(payload ? { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload) } : {}) } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { response.destroy(); reject(new ApiError()); }
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new ApiError()));
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode >= 400) {
              const code = result.error?.code;
              reject(new ApiError(typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : undefined));
            } else resolve(result);
          } catch { reject(new ApiError()); }
        });
      });
      request.setTimeout(this.timeout, () => request.destroy(new Error('timeout')));
      request.on('error', () => reject(new ApiError()));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
module.exports = ApiClient;
module.exports.ApiError = ApiError;
