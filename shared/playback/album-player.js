'use strict';
const { metadata, milliseconds, time, error } = require('./soap');

class AlbumPlayerTransport {
  constructor({ client, mpd, sm, service, onError = () => {}, pollMs = 500, startupTimeoutMs = 20000 }) {
    Object.assign(this, { client, mpd, sm, service, onError, pollMs, startupTimeoutMs });
    this.kind = 'album_player'; this.session = null; this.timer = null; this.polling = false;
  }
  activate() { return this.sm.setConsumeUpdateService(this.service, true, false); }
  close() { clearTimeout(this.timer); this.timer = null; this.session = null; }
  owned(session) { return this.session === session && session.valid(); }
  async play(url, track, valid, ownsTrack = valid) {
    this.close();
    const session = { valid, track, seenPlaying: false, ended: false, position: 0, duration: (track.duration || 0) * 1000, startedAt: Date.now() };
    this.session = session;
    if (!this.owned(session)) return false;
    await this.mpd.stop();
    if (!this.owned(session)) return false;
    await this.client.call('Stop', { InstanceID: 0 });
    if (!this.owned(session)) return false;
    await this.client.call('SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: metadata(url, track) });
    if (!this.owned(session)) return false;
    await this.activate();
    if (!this.owned(session)) return false;
    await this.client.call('Play', { InstanceID: 0, Speed: 1 });
    if (!this.owned(session)) return false;
    session.valid = ownsTrack;
    session.startedAt = Date.now();
    this.schedule();
    return true;
  }
  schedule() {
    if (!this.session || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.poll().finally(() => this.schedule()); }, this.pollMs);
    this.timer.unref?.();
  }
  async poll() {
    const session = this.session;
    if (!session || this.polling) return;
    if (!this.owned(session)) { this.close(); return; }
    this.polling = true;
    try {
      const state = await this.client.call('GetTransportInfo', { InstanceID: 0 });
      if (!this.owned(session)) return;
      if (state.CurrentTransportStatus && state.CurrentTransportStatus !== 'OK') throw error('ENGINE_ERROR');
      const position = await this.client.call('GetPositionInfo', { InstanceID: 0 });
      if (!this.owned(session)) return;
      const status = { PLAYING: 'play', PAUSED_PLAYBACK: 'pause', STOPPED: 'stop', NO_MEDIA_PRESENT: 'stop' }[state.CurrentTransportState];
      if (!status) {
        if (!session.seenPlaying && Date.now() - session.startedAt > this.startupTimeoutMs) throw error('ENGINE_UNAVAILABLE');
        return;
      }
      if (status !== 'stop') {
        const elapsed = milliseconds(position.RelTime), duration = milliseconds(position.TrackDuration);
        if (elapsed === null) throw error('ENGINE_ERROR');
        session.position = elapsed;
        if (duration > 0) session.duration = duration;
        if (status === 'play') session.seenPlaying = true;
      } else if (!session.seenPlaying) {
        if (Date.now() - session.startedAt > this.startupTimeoutMs) throw error('ENGINE_UNAVAILABLE');
        return;
      } else {
        // An early stop is an error, not permission to skip a user's song.
        if (!session.duration || session.duration - session.position > Math.max(3000, this.pollMs * 2)) throw error('ENGINE_ERROR');
        if (session.ended) return;
        session.ended = true;
        this.close();
      }
      await this.sm.syncState({ status, uri: session.track.uri, service: this.service, isStreaming: true,
        seek: status === 'stop' ? session.position : milliseconds(position.RelTime), duration: session.duration / 1000,
        trackType: session.track.trackType || 'flac' }, this.service);
    } catch (e) {
      if (this.owned(session)) { this.close(); this.onError(e); }
    } finally { this.polling = false; }
  }
  async stop() { this.close(); await this.client.call('Stop', { InstanceID: 0 }); }
  pause() { return this.client.call('Pause', { InstanceID: 0 }); }
  resume() { return this.client.call('Play', { InstanceID: 0, Speed: 1 }); }
  async seek(ms) {
    const target = time(ms);
    await this.client.call('Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: target });
    if (this.session) this.session.position = ms;
  }
}
module.exports = AlbumPlayerTransport;
