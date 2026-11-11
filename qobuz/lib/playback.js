'use strict';
const { createTransport } = require('./transport');

class Playback {
  constructor(api, mpd, stateMachine, onError, quality = () => '27', transport) {
    this.api = api; this.mpd = mpd; this.sm = stateMachine; this.onError = onError; this.quality = quality;
    this.generation = 0; this.serial = Promise.resolve(); this.track = null; this.started = false;
    this.lastQuality = null; this.onQuality = () => {};
    this.probeQuality = null;
    this.transport = transport || createTransport({ mpd, sm: stateMachine });
  }
  current(track = this.track) {
    if (this.sm.isVolatile || this.sm.isUpnp) return false;
    const state = typeof this.sm.getTrack === 'function'
      ? this.sm.getTrack(this.sm.currentPosition) : this.sm.getState();
    return !!state && (state.service === 'qobuz_custom' || /^qobuz_custom\/track\//.test(state.uri || '')) && (!state.uri || state.uri === track?.uri);
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
    const valid = () => generation === this.generation && this.current(track);
    try {
      const match = /^qobuz_custom\/track\/(\d+(?:%3A\d+)?)$/i.exec(track.uri);
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
        if (valid()) {
          this.lastQuality = { uri: track.uri, codec: result.codec, sampleRate: result.sampleRate, bitDepth: result.bitDepth };
          this.onQuality(this.lastQuality);
          if (this.probeQuality) {
            Promise.resolve(this.probeQuality(url)).then(measured => {
              if (!valid() || !this.lastQuality || this.lastQuality.uri !== track.uri) return;
              this.lastQuality = { ...this.lastQuality, ...measured };
              this.onQuality(this.lastQuality);
            }).catch(() => {});
          }
        }
      });
    } catch (error) {
      if (valid()) this.onError(error);
    }
  }
  stop() {
    const track = this.track;
    this.cancel(); this.track = null; this.started = false; this.lastQuality = null;
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
