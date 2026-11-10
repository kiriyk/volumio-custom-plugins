export function isYandexRoot(uri: string): boolean { return uri === 'yandex_music'; }
export function needsYandexListHead(uri: string, type?: string): boolean {
  return (uri === 'yandex_music' || uri.startsWith('yandex_music/')) && !type;
}
