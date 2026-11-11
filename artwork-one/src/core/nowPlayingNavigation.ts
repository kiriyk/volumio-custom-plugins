interface Track { uri?: string; service?: string; artist?: string; album?: string }
interface Folder { uri: string; service: string; type: string; title: string; name?: string }
type Browse = (path: string, params: Record<string, string>) => Promise<any>;

function source(track: Track): string | null {
  if (/^qobuz_custom\/track\/\d+$/.test(track.uri || '')) return 'qobuz_custom';
  if (/^yandex_music\/track\/[^/?#]+$/.test(track.uri || '')) return 'yandex_music';
  return track.service === 'mpd' && !/^(qobuz_custom|yandex_music)(?:\/|$)/.test(track.uri || '') ? 'mpd' : null;
}

export function canOpenTrackInfo(track: Track): boolean {
  return !!source(track) && !!track.artist;
}

export async function trackInfoFolder(track: Track, kind: 'artist' | 'album', browse: Browse): Promise<Folder | null> {
  const service = source(track);
  const title = track[kind];
  if (!service || !title) return null;
  if (service === 'mpd') {
    if (!track.artist) return null;
    return { uri: kind === 'artist' ? 'artists://' + encodeURIComponent(title) : 'albums://' + encodeURIComponent(track.artist) + '/' + encodeURIComponent(title), service, type: 'folder', title };
  }
  // Track detail is read over REST: opening a song through the row action would play it.
  let page: any = null;
  try { page = await browse('browse', { uri: track.uri! }); } catch { /* source search remains available */ }
  const folders = (page?.navigation?.lists || []).flatMap((list: any) => list.items || []);
  const prefix = service + '/' + kind + '/';
  const candidates = folders.filter((item: any) => item.type === 'folder' && typeof item.uri === 'string' && item.uri.startsWith(prefix) && /^[-\w%]+$/.test(item.uri.slice(prefix.length)));
  const direct = candidates.find((item: any) => (item.title || item.name) === title) || candidates[0];
  if (direct) return { uri: direct.uri, service, type: 'folder', title: direct.title || direct.name || title };
  return { uri: `${service}/search?q=${encodeURIComponent(title)}&type=${kind}`, service, type: 'folder', title };
}
