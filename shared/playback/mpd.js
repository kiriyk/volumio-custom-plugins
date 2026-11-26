'use strict';
const { performance } = require('node:perf_hooks');
const subscribe = require('./mpd-events');

function mpdArgument(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('BAD_REQUEST');
  return '"' + value.replace(/["\\]/g, '\\$&') + '"';
}

class MpdTransport {
  constructor({ mpd, sm, service, observerMpd = mpd, onTrackEnd = () => {}, onError = () => {} } = {}) {
    this.kind = 'mpd'; this.mpd = mpd; this.sm = sm; this.service = service; this.observer = observerMpd;
    this.onTrackEnd = onTrackEnd; this.onError = onError; this.session = null;
  }
  observe() {
    if (this.unsubscribe) return;
    const transport = this;
    this.unsubscribe = subscribe(this.observer, (raw, state) => {
      const session = transport.session;
      if (session && session.valid()) {
        if (state.status === 'play' || state.status === 'pause') {
          const firstPlay = state.status === 'play' && !session.seen;
          if (state.status === 'play') session.seen = true;
          if (Number.isFinite(state.seek)) session.position = state.seek;
          if (state.duration > 0) session.duration = state.duration * 1000;
          session.at = performance.now(); session.status = state.status;
          if (transport.sm.consumeState && transport.sm.consumeUpdateService === 'mpd') {
            transport.sm.consumeState.status = state.status;
            if (state.duration > 0) transport.sm.consumeState.duration = state.duration;
          }
          // Core's first stop -> play sync changes currentStatus without publishing.
          // Publish the confirmed logical snapshot even if MPD sends no second update.
          if (firstPlay && transport.sm.pushState) Promise.resolve(transport.sm.pushState()).catch(transport.onError);
        } else if (state.status === 'stop' && session.seen && !session.ended) {
          session.ended = true;
          const position = session.position + (session.status === 'play' ? performance.now() - session.at : 0);
          if (raw.error || (transport.sm.currentStatus === 'play' && session.duration - position > 3000)) {
            transport.onError(Object.assign(new Error('ENGINE_ERROR'), { code: 'ENGINE_ERROR' }));
          } else if (transport.sm.currentStatus === 'play' && session.duration > 0) {
            transport.onTrackEnd(session.track);
          }
        }
      }
    });
  }
  async activate() {
    const activated = this.sm.setConsumeUpdateService('mpd', true, false);
    if (this.sm.consumeState) {
      if (this.service) this.sm.consumeState.service = this.service;
      this.sm.consumeState.status = this.sm.currentStatus;
    }
    await activated;
  }
  async play(url, track, valid, ownsTrack = valid) {
    // Only the generated loopback HTTP stream is put in the MPD command string.
    if (typeof url !== 'string' || /[\r\n"\\]/.test(url)) throw new Error('BAD_REQUEST');
    return this.playCommand('add ' + mpdArgument(url), track, valid, ownsTrack);
  }
  playLocal(local, track, valid) {
    const uri = mpdArgument(local.uri);
    const command = local.index === undefined ? 'add ' + uri :
      `load ${uri} ${local.index}:${local.index + 1}`;
    return this.playCommand(command, track, valid);
  }
  async playCommand(add, track, valid, ownsTrack = valid) {
    this.session = null;
    this.observe();
    for (const command of ['stop', 'clear', add]) {
      if (!valid()) return false;
      const result = await this.mpd.sendMpdCommand(command, []);
      if (result?.error) throw new Error(result.error);
    }
    if (!valid()) return false;
    this.sm.currentSongDuration = (track.duration || 0) * 1000;
    await this.activate();
    if (!valid()) return false;
    if (this.sm.consumeState) this.sm.consumeState = {
      status: this.sm.currentStatus, service: this.service || track.service, uri: track.uri,
      title: track.name || track.title, artist: track.artist, album: track.album,
      albumart: track.albumart, duration: track.duration, trackType: track.trackType
    };
    this.session = { track, valid: ownsTrack, seen: false, ended: false, position: 0, at: performance.now(), status: 'stop', duration: (track.duration || 0) * 1000 };
    const result = await this.mpd.sendMpdCommand('play', []);
    if (result?.error) throw new Error(result.error);
    return true;
  }
  stop() { this.session = null; return this.mpd.stop(); }
  pause() { return this.mpd.pause(); }
  resume() { return this.mpd.resume(); }
  seek(ms) { return this.mpd.seek(ms); }
  close() {
    this.session = null;
    this.unsubscribe?.(); this.unsubscribe = null;
  }
}
module.exports = MpdTransport;
module.exports.mpdArgument = mpdArgument;
