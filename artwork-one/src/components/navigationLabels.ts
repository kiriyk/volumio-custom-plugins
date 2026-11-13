import type { BrowseItem } from '../core/store/browse';

const SOURCE_LABELS: Record<string, string> = {
  playlists: 'Плейлисты', favourites: 'Избранное', 'music-library': 'Музыкальная библиотека',
  'artists://': 'Исполнители', 'albums://': 'Альбомы', 'genres://': 'Жанры',
  radio: 'Радио', upnp: 'Медиасерверы', Last_100: 'Последние 100',
};

/** Translate built-in navigation by URI, preserving provider names and music metadata. */
export function sourceLabel(item: Pick<BrowseItem, 'uri' | 'name' | 'title'>): string {
  return SOURCE_LABELS[item.uri] || String(item.name || item.title || item.uri);
}
