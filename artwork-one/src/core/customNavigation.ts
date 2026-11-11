export function customService(uri?: string): string | null {
  return /^qobuz_custom(?:\/|$)/.test(uri || '') ? 'qobuz_custom'
    : /^yandex_music(?:\/|$)/.test(uri || '') ? 'yandex_music' : null;
}

export function customCrumbs(trail: any[], uri: string, sources: any[]): any[] {
  const ancestors = trail.slice(0, -1).filter(s => (s.title || s.name) && !/^albums:\/\/[^/]+\/.+/.test(String(s.uri || '')));
  const service = customService(uri);
  if (!service) return ancestors.slice(-2);
  if (uri === service) return [];
  if (ancestors.some(s => s.uri === service)) return ancestors;
  const source = sources.find(s => s.uri === service);
  return [{ ...source, uri: service, service, title: service === 'qobuz_custom' ? 'Qobuz' : 'Яндекс Музыка' }, ...ancestors];
}

export function playbackQualityState(raw: any, measured: any): any {
  const result = { ...raw };
  const service = customService(raw?.uri);
  if (!service) return result;
  result.service = service;
  delete result.bitrate;
  // MPD may label the transport/container instead of the codec.
  if (service === 'qobuz_custom') result.trackType = 'flac';
  else if (result.trackType === 'mp4') result.trackType = '';
  if (measured?.uri === raw.uri) {
    result.trackType = measured.codec === 'flac-mp4' ? 'flac' : measured.codec;
    if (Number.isFinite(measured.sampleRate) && measured.sampleRate > 0) result.samplerate = `${measured.sampleRate / 1000} kHz`;
    if (Number.isFinite(measured.bitDepth) && measured.bitDepth > 0) result.bitdepth = `${measured.bitDepth} bit`;
  }
  return result;
}
