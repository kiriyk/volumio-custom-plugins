'use strict';
async function nativeQuality(mpd, uri) {
  if (!/^qobuz_custom\/track\/\d+$/.test(uri || '')) return null;
  const status = await mpd.sendMpdCommand('status', []);
  if (!status.audio || status.song == null) return null;
  const song = await mpd.sendMpdCommand('playlistinfo', [Number(status.song)]);
  if (!/^http:\/\/127\.0\.0\.1:17901\/stream\//.test(String(song.file || ''))) return null;
  const [sampleRate, bitDepth] = String(status.audio).split(':').map(Number);
  if (!(sampleRate > 0 && bitDepth > 0)) return null;
  return { uri, codec:'flac', sampleRate, bitDepth };
}
module.exports = nativeQuality;
