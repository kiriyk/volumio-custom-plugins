interface List { items?: { type?: string }[] }

export function showDownloads(uri: string): boolean {
  return uri === 'qobuz_custom/downloads';
}

// A page-wide table heading only describes a single, uniform list rendered as rows.
export function showTrackColumns(lists: List[], options: { searching: boolean; artist: boolean; downloads: boolean; grid: boolean }): boolean {
  if (options.searching || options.artist || options.downloads || options.grid) return false;
  const populated = lists.filter(list => list.items?.length);
  return populated.length === 1 && populated[0].items!.every(item => item.type === 'song');
}
