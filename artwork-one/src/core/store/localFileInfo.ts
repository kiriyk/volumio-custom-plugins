import { useEffect, type RefObject } from 'react';
import { create } from 'zustand';
import { pluginRest } from '../api';
import { on } from '../socket';

interface Entry { uri: string; size?: number; bitrate?: number | null }
interface LocalFileStore { entries: Record<string, Entry> }
const useLocalFileStore = create<LocalFileStore>(() => ({ entries: {} }));
const requested = new Map<string, number>();

export function requestLocalFileInfo(uri: string): void {
  if (!/^(?:\/?(?:mnt|music-library)\/)?(?:USB|NAS|INTERNAL)\//.test(uri)) return;
  if ((requested.get(uri) || 0) > Date.now() - 300000) return;
  const started = Date.now();
  requested.set(uri, started);
  if (requested.size > 500) requested.delete(requested.keys().next().value!);
  void pluginRest<Omit<Entry, 'uri'> | null>('artworkOneLocalFileInfo', { uri }).then(info => {
    if (requested.get(uri) === started && info) store({ uri, ...info });
  }).catch(() => {
    if (requested.get(uri) === started) requested.delete(uri);
  });
}

function store(info: Entry) {
  useLocalFileStore.setState(state => {
    const entries = { ...state.entries };
    delete entries[info.uri];
    entries[info.uri] = info;
    const keys = Object.keys(entries);
    if (keys.length > 500) delete entries[keys[0]];
    return { entries };
  });
}

on('pushArtworkCacheCleared', () => {
  requested.clear();
  useLocalFileStore.setState({ entries: {} });
});

export function useLocalFileInfo(uri?: string, enabled = false, ref?: RefObject<HTMLElement | null>): Entry | undefined {
  const entry = useLocalFileStore(state => uri ? state.entries[uri] : undefined);
  useEffect(() => {
    if (!enabled || !uri) return;
    const element = ref?.current;
    if (!element || typeof IntersectionObserver === 'undefined') { requestLocalFileInfo(uri); return; }
    const observer = new IntersectionObserver(items => {
      if (items.some(item => item.isIntersecting)) { requestLocalFileInfo(uri); observer.disconnect(); }
    }, { rootMargin: '150px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [uri, enabled, ref]);
  return entry;
}
