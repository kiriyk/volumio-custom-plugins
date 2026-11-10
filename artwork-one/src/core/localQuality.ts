export function formatLocalQuality(info: {size: number | null; bitrate: number | null}): string {
  const rate = info.bitrate && info.bitrate > 0 ? `${Math.round(info.bitrate / 1000)} кбит/с` : '';
  const size = info.size != null && info.size >= 0 ? `${Number((info.size / 1048576).toFixed(1))} МиБ` : '';
  return [rate, size].filter(Boolean).join(' · ');
}
