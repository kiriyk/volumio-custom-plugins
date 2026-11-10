export function isCustomMusicRoot(uri: string): boolean {
  return uri === 'yandex_music' || uri === 'qobuz_custom';
}
export function isCustomMusicPage(uri: string): boolean {
  return isCustomMusicRoot(uri) || uri.startsWith('yandex_music/') || uri.startsWith('qobuz_custom/');
}
export function needsCustomMusicListHead(uri: string, type?: string): boolean {
  return isCustomMusicPage(uri) && !type;
}
