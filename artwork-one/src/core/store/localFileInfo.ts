import { useEffect, type RefObject } from 'react';
import { create } from 'zustand';
import { emit, on } from '../socket';

interface Entry { uri: string; size?: number; bitrate?: number | null }
interface LocalFileStore { entries: Record<string, Entry> }
const useLocalFileStore = create<LocalFileStore>(() => ({ entries: {} }));
const requested = new Map<string, number>();

export function requestLocalFileInfo(uri: string): void {
  if (!/^(?:mnt|music-library)\/(?:USB|NAS|INTERNAL)\//.test(uri)) return;
  if ((requested.get(uri) || 0) > Date.now() - 300000) return;
  requested.set(uri, Date.now());
  if (requested.size > 500) requested.delete(requested.keys().next().value!);
  emit('callMethod', { endpoint: 'music_service/yandex_music', method: 'getLocalFileInfo', data: { uri } });
}

on('pushLocalFileInfo', (info: Entry) => {
  if (!info || typeof info.uri !== 'string') return;
  useLocalFileStore.setState(state => ({ entries: { ...state.entries, [info.uri]: info } }));
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
