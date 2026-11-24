'use strict';
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);

const TTL = 60 * 60 * 1000;
const MAX_ENTRIES = 64;
const MAX_PENDING = 2;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;

async function probeStream(url) {
  const { stdout } = await exec('/usr/bin/ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,bits_per_raw_sample,channels,bit_rate:format=bit_rate',
    '-of', 'json', url], { timeout: 15000, maxBuffer: 16384 });
  const { streams, format } = JSON.parse(stdout);
  const stream = streams?.[0];
  if (!stream) return {};
  const bitrate = positive(stream.bit_rate) || positive(format?.bit_rate);
  return {
    sampleRate: positive(stream.sample_rate),
    bitDepth: positive(stream.bits_per_raw_sample),
    channels: positive(stream.channels),
    bitrate: bitrate && Math.round(bitrate / 1000)
  };
}

class StreamQuality {
  constructor() {
    this.entries = new Map();
    this.pending = new Map();
  }

  async measure(key, url, probe) {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    this.entries.delete(key);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= MAX_PENDING) return {};
    const request = Promise.resolve().then(() => probe(url)).then(value => {
      this.entries.set(key, { value, expires: Date.now() + TTL });
      if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}

module.exports = { StreamQuality, probeStream, positive };
