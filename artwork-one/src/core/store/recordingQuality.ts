import { useEffect, type RefObject } from 'react';
import { create } from 'zustand';
import { emit, on } from '../socket';
import type { RecordingQuality } from '../recordingQuality';

interface Entry { uri: string; recordingQuality: RecordingQuality | null }
const useQualities = create<{entries: Record<string, Entry>}>(() => ({entries:{}}));
const queue = new Set<string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const expires = new Map<string, number>();
const isYandex = (uri: string) => /^yandex_music\/track\/\d{1,24}(?:(?:%3A|:)\d{1,24})?$/i.test(uri);

function finish(entry: Entry) {
  const timer = pending.get(entry.uri);
  if (timer !== undefined) clearTimeout(timer);
  pending.delete(entry.uri);
  expires.delete(entry.uri);
  expires.set(entry.uri, Date.now() + (entry.recordingQuality ? 3600000 : 300000));
  while (expires.size > 512) expires.delete(expires.keys().next().value!);
  useQualities.setState(state => {
    const entries = {...state.entries};
    delete entries[entry.uri];
    entries[entry.uri] = entry;
    while (Object.keys(entries).length > 512) delete entries[Object.keys(entries)[0]];
    return {entries};
  });
  pump();
}

function pump() {
  while (pending.size < 2 && queue.size) {
    const uri = queue.values().next().value!;
    queue.delete(uri);
    pending.set(uri, setTimeout(() => finish({uri,recordingQuality:null}), 30000));
    emit('callMethod', {endpoint:'music_service/yandex_music',method:'getRecordingQuality',data:{uri}});
  }
}

function request(uri: string) {
  if (!isYandex(uri) || pending.has(uri) || queue.has(uri) || (expires.get(uri) || 0) > Date.now()) return;
  if (queue.size >= 64) return;
  queue.add(uri);
  pump();
}

on('pushRecordingQuality', (entry: Entry) => {
  if (!entry || typeof entry.uri !== 'string' || !isYandex(entry.uri) || !pending.has(entry.uri)) return;
  const q = entry.recordingQuality;
  finish({uri:entry.uri,recordingQuality:q && q.basis === 'available' && ['flac','mp3'].includes(q.codec) ? q : null});
});

export function useRecordingQuality(item: {uri?: string; type?: string; recordingQuality?: RecordingQuality}, ref: RefObject<HTMLElement | null>): RecordingQuality | null | undefined {
  const uri = item.uri || '';
  const entry = useQualities(state => state.entries[uri]);
  useEffect(() => {
    if (item.recordingQuality || item.type !== 'song' || !isYandex(uri)) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { request(uri); observer.disconnect(); }
    }, {rootMargin:'100px'});
    observer.observe(el);
    return () => observer.disconnect();
  }, [uri,item.type,item.recordingQuality,ref]);
  return item.recordingQuality || entry?.recordingQuality;
}
