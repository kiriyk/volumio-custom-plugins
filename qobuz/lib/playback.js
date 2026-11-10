'use strict';

class Playback {
  constructor(api, mpd, stateMachine, onError, quality = () => '27') {
    this.api = api; this.mpd = mpd; this.sm = stateMachine; this.onError = onError; this.quality = quality;
    this.generation = 0; this.serial = Promise.resolve(); this.track = null; this.started = false;
    this.lastQuality = null; this.onQuality = () => {};
    this.probeQuality = null;
  }
  current(track = this.track) {
    if (this.sm.isVolatile || this.sm.isUpnp) return false;
    const state = typeof this.sm.getTrack === 'function'
      ? this.sm.getTrack(this.sm.currentPosition) : this.sm.getState();
    return !!state && state.service === 'qobuz_custom' && (!state.uri || state.uri === track?.uri);
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
        await this.mpd.sendMpdCommand('stop', []);
        if (!valid()) return;
        await this.mpd.sendMpdCommand('clear', []);
        if (!valid()) return;
        await this.mpd.sendMpdCommand(`add "${url}"`, []);
        if (!valid()) return;
        this.sm.currentSongDuration = (track.duration || 0) * 1000;
        await this.sm.setConsumeUpdateService('mpd', true, false);
        if (!valid()) return;
        await this.mpd.sendMpdCommand('play', []);
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
      await this.sm.setConsumeUpdateService('mpd', true, false);
      if (generation !== this.generation || !this.current(track)) return;
      return this.mpd.stop();
    });
  }
  pause() {
    this.cancel();
    const generation = this.generation;
    if (!this.started) return Promise.resolve();
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.current()) return;
      await this.sm.setConsumeUpdateService('mpd', true, false);
      if (generation !== this.generation || !this.current()) return;
      return this.mpd.pause();
    });
  }
  resume() {
    if (!this.current()) return Promise.resolve();
    if (!this.started && this.track) return this.clearAddPlayTrack(this.track);
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.current()) return;
      await this.sm.setConsumeUpdateService('mpd', true, false);
      if (generation !== this.generation || !this.current()) return;
      return this.mpd.resume();
    });
  }
  seek(position) {
    if (!Number.isFinite(position) || position < 0) return Promise.reject(new Error('BAD_REQUEST'));
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.current()) return;
      await this.sm.setConsumeUpdateService('mpd', true, false);
      if (generation !== this.generation || !this.current()) return;
      return this.mpd.seek(position);
    });
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
