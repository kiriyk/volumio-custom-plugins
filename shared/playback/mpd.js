'use strict';
class MpdTransport {
  constructor({ mpd, sm } = {}) { this.kind = 'mpd'; this.mpd = mpd; this.sm = sm; }
  activate() { return this.sm.setConsumeUpdateService('mpd', true, false); }
  async play(url, track, valid) {
    // Only the generated loopback HTTP stream is put in the MPD command string.
    if (typeof url !== 'string' || /[\r\n"\\]/.test(url)) throw new Error('BAD_REQUEST');
    for (const command of ['stop', 'clear', `add "${url}"`]) {
      if (!valid()) return false;
      await this.mpd.sendMpdCommand(command, []);
    }
    if (!valid()) return false;
    this.sm.currentSongDuration = (track.duration || 0) * 1000;
    await this.activate();
    if (!valid()) return false;
    await this.mpd.sendMpdCommand('play', []);
    return true;
  }
  stop() { return this.mpd.stop(); }
  pause() { return this.mpd.pause(); }
  resume() { return this.mpd.resume(); }
  seek(ms) { return this.mpd.seek(ms); }
  close() {}
}
module.exports = MpdTransport;
