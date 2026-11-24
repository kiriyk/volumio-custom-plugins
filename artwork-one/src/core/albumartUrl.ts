/** Ask Volumio to search the album directory instead of serving CUE text as an image. */
export function normalizeAlbumartPath(url: string): string {
  if (!url.startsWith('/albumart?')) return url;

  // Change only the path value; web/cache/metadata parameters and fragments keep their encoding.
  const fragmentAt = url.indexOf('#');
  const query = fragmentAt < 0 ? url : url.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : url.slice(fragmentAt);
  return query.replace(/([?&]path=)([^&#]*)/g, (parameter, prefix: string, value: string) => {
    let path: string;
    try {
      path = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      return parameter;
    }
    const cue = /^(.*)\/[^/]+\.cue(?:\/track\d+)?\/?$/i.exec(path);
    return cue ? prefix + encodeURIComponent(cue[1] || '/') : parameter;
  }) + fragment;
}

export function canvasCoverUrl(url: string, operation: 'bake' | 'palette'): string {
  // Safari can reuse a plain img response for a CORS load. Separate network requests only.
  if (/^(?:blob|data):/i.test(url)) return url;
  const fragmentAt = url.indexOf('#');
  const query = fragmentAt < 0 ? url : url.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : url.slice(fragmentAt);
  return query + (query.includes('?') ? '&' : '?') + 'aw=' + operation + fragment;
}
