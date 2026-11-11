export interface RecordingQuality { codec: string; bitDepth?: number; sampleRate?: number; bitrate?: number; basis?: string }

export function formatRecordingQuality(q?: RecordingQuality | null): string {
  if (!q || !['flac', 'mp3'].includes(q.codec)) return '';
  const parts = [q.codec.toUpperCase()];
  if (q.codec === 'flac' && Number.isFinite(q.bitDepth) && Number.isFinite(q.sampleRate) && q.bitDepth! > 0 && q.sampleRate! > 0) {
    parts.push(`${q.bitDepth} бит / ${q.sampleRate! / 1000} кГц`);
  } else if (q.codec === 'mp3' && Number.isFinite(q.bitrate) && q.bitrate! > 0) {
    parts.push(`${q.bitrate} кбит/с`);
  }
  return parts.join(' · ');
}

export function artistCountLabel(item: {uri?: string; type?: string}, enabled: boolean, saved: {uri: string; text: string}): string {
  return enabled && item.type === 'folder' && /^artists:\/\//.test(item.uri || '') && saved.uri === item.uri ? saved.text : '';
}
