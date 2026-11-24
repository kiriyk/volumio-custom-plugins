export function localAlbumUri(uri?: string): string | undefined {
  return /^(?:albums|artists):\/\/[^/]*\/[^/]+$|^genres:\/\/[^/]+\/[^/]*\/[^/]+$/.test(uri || '') ? uri : undefined;
}

export function localArtistUri(uri?: string): string | undefined {
  return /^artists:\/\/[^/]+$/.test(uri || '') ? uri : undefined;
}

export function localPlayingUri(state?: { uri?: unknown; title?: unknown }): string | undefined {
  const uri = state?.uri;
  if (!state?.title || typeof uri !== 'string') return;
  if (!/^(?:\/?(?:mnt|music-library)\/)?(?:USB|NAS|INTERNAL)\/.+\.(?:[a-z\d]+|cue\/track\d+)$/i.test(uri)) return;
  return uri.replace(/^\/?(?:mnt|music-library)\//, '');
}

export function localPlayingAlbumKey(state: { album?: unknown; albumartist?: unknown; artist?: unknown }, uri: string): string {
  if (typeof state.album !== 'string' || !state.album.trim()) return uri;
  const cue = /^(.+\.cue)(?:\/track\d+)?$/i.exec(uri);
  const location = cue ? cue[1] : uri.slice(0, uri.lastIndexOf('/'));
  return JSON.stringify([location, state.album, state.albumartist || state.artist || '']);
}
