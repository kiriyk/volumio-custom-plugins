export function searchableSources(sources: any[]): any[] {
  const library = sources.find(s => s.uri === 'music-library');
  const builtIn = ['favourites', 'playlists', 'music-library', 'artists://', 'albums://', 'genres://', 'upnp', 'Last_100'];
  const unique = new Map<string, any>();
  for (const source of [library ? { ...library, service: 'mpd', plugin_name: 'mpd', plugin_type: 'music_service' } : null,
    ...sources.filter(s => !builtIn.includes(s.uri))]) {
    if (source?.uri) unique.set(source.uri, source);
  }
  return [...unique.values()];
}
