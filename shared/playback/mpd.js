'use strict';

function mpdArgument(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('BAD_REQUEST');
  return '"' + value.replace(/["\\]/g, '\\$&') + '"';
}

class MpdTransport {
  constructor({ mpd, sm } = {}) { this.kind = 'mpd'; this.mpd = mpd; this.sm = sm; }
  activate() { return this.sm.setConsumeUpdateService('mpd', true, false); }
  async play(url, track, valid) {
    // Only the generated loopback HTTP stream is put in the MPD command string.
    if (typeof url !== 'string' || /[\r\n"\\]/.test(url)) throw new Error('BAD_REQUEST');
    return this.playCommand('add ' + mpdArgument(url), track, valid);
  }
  playLocal(local, track, valid) {
    const uri = mpdArgument(local.uri);
    const command = local.index === undefined ? 'add ' + uri :
      `load ${uri} ${local.index}:${local.index + 1}`;
    return this.playCommand(command, track, valid);
  }
  async playCommand(add, track, valid) {
    for (const command of ['stop', 'clear', add]) {
      if (!valid()) return false;
      const result = await this.mpd.sendMpdCommand(command, []);
      if (result?.error) throw new Error(result.error);
    }
    if (!valid()) return false;
    this.sm.currentSongDuration = (track.duration || 0) * 1000;
    await this.activate();
    if (!valid()) return false;
    const result = await this.mpd.sendMpdCommand('play', []);
    if (result?.error) throw new Error(result.error);
    return true;
  }
  stop() { return this.mpd.stop(); }
  pause() { return this.mpd.pause(); }
  resume() { return this.mpd.resume(); }
  seek(ms) { return this.mpd.seek(ms); }
  close() {}
}
module.exports = MpdTransport;
module.exports.mpdArgument = mpdArgument;
