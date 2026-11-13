interface ArtworkItem { uri?: string; type?: string; albumart?: string; title?: string }

/** Local UI artwork for provider collection navigation tiles; provider covers win. */
export function librarySectionArtwork(item: ArtworkItem): string | undefined {
  if (item.albumart || (item.type && item.type !== 'folder')) return undefined;
  switch (item.uri) {
    case 'qobuz_custom/library/albums': return '/library-albums-qobuz.svg';
    case 'qobuz_custom/library/artists': return '/library-artists-qobuz.svg';
    case 'qobuz_custom/downloads': return '/library-downloads-qobuz.svg';
    case 'yandex_music/library/tracks': return '/library-tracks-yandex.svg';
    case 'yandex_music/library/playlists': return '/library-playlists-yandex.svg';
    case 'yandex_music/library/albums': return '/library-albums-yandex.svg';
    case 'yandex_music/library/artists': return '/library-artists-yandex.svg';
    default: return undefined;
  }
}
