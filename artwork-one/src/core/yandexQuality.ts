export function actualYandexQuality(info: any): Record<string, string> {
  const out: Record<string, string> = { trackType: info.codec === 'flac-mp4' ? 'flac' : info.codec };
  if (Number.isFinite(info.sampleRate) && info.sampleRate > 0) out.samplerate = `${info.sampleRate / 1000} kHz`;
  if (Number.isFinite(info.bitDepth) && info.bitDepth > 0) out.bitdepth = `${info.bitDepth} bit`;
  return out;
}
