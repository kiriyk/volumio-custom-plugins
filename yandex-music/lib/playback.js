'use strict';
const { createTransport, StreamQuality, positive } = require('./transport');

class Playback {
  constructor(api, mpd, stateMachine, onError, quality = () => 'auto', transport) {
    this.api = api; this.mpd = mpd; this.sm = stateMachine; this.onError = onError; this.quality = quality;
    this.generation = 0; this.serial = Promise.resolve(); this.track = null; this.started = false;
    this.lastQuality = null; this.onQuality = () => {};
    this.probeQuality = null;
    this.qualityCache = new StreamQuality();
    this.transport = transport || createTransport({ mpd, sm: stateMachine });
  }
  current(track = this.track) {
    if (this.sm.isVolatile || this.sm.isUpnp) return false;
    const state = typeof this.sm.getTrack === 'function'
      ? this.sm.getTrack(this.sm.currentPosition) : this.sm.getState();
    return !!state && state.service === 'yandex_music' && (!state.uri || state.uri === track?.uri);
  }
  cancel() { this.generation++; }
  enqueue(operation) {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {});
    return next;
  }
  async clearAddPlayTrack(track) {
    const generation = ++this.generation;
    this.track = track; this.started = false; this.lastQuality = null;
    this.onQuality({ uri: track.uri, generation });
    const valid = () => generation === this.generation && this.current(track);
    try {
      const match = /^yandex_music\/track\/(\d+(?:%3A\d+)?)$/i.exec(track.uri);
      if (!match) throw new Error('BAD_REQUEST');
      const result = await this.api.request('POST', '/v1/playback/resolve', { track_id: decodeURIComponent(match[1]), quality: this.quality() });
      if (!valid()) return;
      const url = this.api.streamUrl(result.path, result.codec);
      await this.enqueue(async () => {
        if (!valid()) return;
        const trackType = { 'flac': 'flac', 'flac-mp4': 'mp4', 'mp3': 'mp3' }[result.codec];
        const played = await this.transport.play(url, { ...track, trackType }, valid,
          () => this.track === track && this.current(track));
        if (!played || !valid()) return;
        this.started = true;
        const { codec } = result;
        const bitrate = codec === 'mp3' ? positive(result.bitrate) : undefined;
        const initial = { uri: track.uri, generation, codec, ...(bitrate && { bitrate }) };
        this.lastQuality = initial;
        this.onQuality(initial);
        if (this.probeQuality) {
          const key = JSON.stringify(['yandex_music', match[1], codec, bitrate]);
          const stillPlaying = () => this.current(track) && this.lastQuality?.generation === generation;
          this.qualityCache.measure(key, url, this.probeQuality).then(measured => {
            if (!stillPlaying()) return;
            const quality = { ...initial };
            for (const field of ['sampleRate', 'bitDepth', 'channels', 'bitrate']) {
              if (!quality[field] && positive(measured[field]) && !(codec === 'mp3' && field === 'bitDepth')) {
                quality[field] = Number(measured[field]);
              }
            }
            if (quality.bitrate && !initial.bitrate) quality.bitrateEstimated = true;
            this.lastQuality = quality;
            this.onQuality(quality);
          }).catch(() => {});
        }
      });
    } catch (error) {
      if (valid()) this.onError(error);
    }
  }
  stop() {
    const track = this.track;
    this.cancel(); this.track = null; this.started = false; this.lastQuality = null;
    if (track && this.current(track)) this.onQuality({ uri: track.uri, generation: this.generation });
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.current(track)) return;
      await this.transport.activate();
      if (generation !== this.generation || !this.current(track)) return;
      return this.transport.stop();
    });
  }
  pause() {
    this.cancel();
    const generation = this.generation;
    if (!this.started && !this.track) return Promise.resolve();
    const wasStarted = this.started;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.current()) return;
      await this.transport.activate();
      if (generation !== this.generation || !this.current()) return;
      // A cancelled launch may already have been accepted by the renderer.
      // Queue cleanup after its pending response instead of leaving it playing.
      return wasStarted ? this.transport.pause() : this.transport.stop();
    });
  }
  resume() {
    if (!this.current()) return Promise.resolve();
    if (!this.started && this.track) return this.clearAddPlayTrack(this.track);
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.current()) return;
      await this.transport.activate();
      if (generation !== this.generation || !this.current()) return;
      return this.transport.resume();
    });
  }
  seek(position) {
    if (!Number.isFinite(position) || position < 0) return Promise.reject(new Error('BAD_REQUEST'));
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.current()) return;
      await this.transport.activate();
      if (generation !== this.generation || !this.current()) return;
      return this.transport.seek(position);
    });
  }
  async next() {
    this.cancel();
    const generation = this.generation;
    if (!this.current()) return;
    await this.sm.setConsumeUpdateService(undefined);
    if (generation !== this.generation || !this.current()) return;
    return this.sm.next();
  }
  async previous() {
    this.cancel();
    const generation = this.generation;
    if (!this.current()) return;
    await this.sm.setConsumeUpdateService(undefined);
    if (generation !== this.generation || !this.current()) return;
    return this.sm.previous();
  }
}
module.exports = Playback;
