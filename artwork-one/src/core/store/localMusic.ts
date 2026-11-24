import { useEffect, useState, type RefObject } from 'react';
import { create } from 'zustand';
import { albumart, pluginRest } from '../api';
import { localPlayingAlbumKey, localPlayingUri } from '../localMusicUri';

export interface AlbumInfo {
  text?: string;
  url?: string;
  localYear?: string;
  year?: string;
  yearType?: 'release' | 'firstRelease';
  label?: string;
  summaryStatus?: 'temporaryError' | 'notFound';
}

export interface ArtistInfo {
  text: string;
  url: string;
  artist?: string;
}

interface Cover {
  url?: string;
  id?: string;
  jpeg?: string;
}

type Data = { cover: Cover; artistInfo: ArtistInfo; albumInfo: AlbumInfo };
type Field = keyof Data;
type Entry<F extends Field = Field> = { until: number; value?: Data[F]; blobUrl?: string };
type Response<F extends Field> = {
  requestId: string;
  key?: string;
  fields?: Partial<Record<F, { status: 'found' | 'notFound' | 'temporaryError'; value?: Data[F]; retryAt?: number }>>;
  error?: 'unsupportedEntity' | 'invalidRequest' | 'temporaryError';
};

const MAX_ENTRIES = 160;
const REGULAR_TTL = 30 * 60_000;
const RETRY = 15 * 60_000;
const useEntries = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
const liveEntries = new Map<string, number>();
const images = new Map<string, { url: string; count: number }>();
const pending = new Set<string>();
const queue: Array<{ key: string; priority: boolean; run: () => Promise<void> }> = [];
let sequence = 0;
let active = 0;

function removeBlob(id?: string) {
  if (!id) return;
  const image = images.get(id);
  if (!image || --image.count > 0) return;
  URL.revokeObjectURL(image.url);
  images.delete(id);
}

function addBlob(cover: Cover): string | undefined {
  if (!cover.id || !cover.jpeg) return;
  const image = images.get(cover.id);
  if (image) {
    image.count++;
    return image.url;
  }
  const bytes = Uint8Array.from(atob(cover.jpeg), ch => ch.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  images.set(cover.id, { url, count: 1 });
  return url;
}

function store(key: string, value: Entry, field: Field) {
  useEntries.setState(state => {
    const entries = { ...state.entries };
    if (field === 'cover') {
      if (value.value) {
        const cover = value.value as Cover;
        value.blobUrl = addBlob(cover);
        value.value = { id: cover.id, url: cover.url };
      }
      removeBlob((entries[key]?.value as Cover | undefined)?.id);
    }
    delete entries[key];
    entries[key] = value;
    let excess = Object.keys(entries).length - MAX_ENTRIES;
    for (const k of Object.keys(entries)) {
      if (excess <= 0) break;
      if (liveEntries.has(k)) continue;
      if (entries[k].blobUrl) removeBlob((entries[k].value as Cover).id);
      delete entries[k];
      excess--;
    }
    return { entries };
  });
}

function drain() {
  while (active < 4 && queue.length) {
    const high = queue.findIndex(job => job.priority);
    if (high < 0 && active >= 3) return;
    const [job] = queue.splice(Math.max(high, 0), 1);
    if (!liveEntries.has(job.key)) {
      pending.delete(job.key);
      continue;
    }
    active++;
    void job.run().finally(() => {
      active--;
      pending.delete(job.key);
      drain();
    });
  }
}

function request<F extends Field>(key: string, uri: string, field: F, kind: 'album' | 'artist', priority: boolean) {
  const hit = useEntries.getState().entries[key];
  if (pending.has(key) || (hit && hit.until > Date.now())) return;
  pending.add(key);
  queue.push({ key, priority, run: async () => {
    const requestId = 'music-' + ++sequence;
    try {
      const answer = await pluginRest<Response<F>>('artworkOneLocalMusicInfo', { requestId, uri, kind, fields: [field] });
      if (answer.requestId !== requestId) throw new Error('Unexpected local music response');
      const result = answer.fields?.[field];
      const retryAt = Math.max(Date.now() + RETRY, result?.retryAt || 0);
      if (result?.status === 'found') {
        const partial = field === 'albumInfo' && (result.value as AlbumInfo)?.summaryStatus === 'temporaryError';
        store(key, { value: result.value, until: partial || result.retryAt ? retryAt : Date.now() + REGULAR_TTL }, field);
      } else if (result?.status !== 'temporaryError' && answer.error !== 'temporaryError') {
        store(key, { until: Date.now() + REGULAR_TTL }, field);
      } else if (hit?.value) {
        useEntries.setState(state => ({ entries: { ...state.entries, [key]: { ...hit, until: retryAt } } }));
      } else {
        store(key, { until: retryAt }, field);
      }
    } catch {
      if (hit?.value) useEntries.setState(state => ({ entries: { ...state.entries, [key]: { ...hit, until: Date.now() + RETRY } } }));
      else store(key, { until: Date.now() + RETRY }, field);
    }
  } });
  drain();
}

function useEntry<F extends Field>(uri: string | undefined, field: F, ref?: RefObject<HTMLElement | null>, kind: 'album' | 'artist' = 'album'): Entry<F> | undefined {
  const key = uri ? JSON.stringify([kind, uri, field]) : '';
  const entry = useEntries(s => s.entries[key]) as Entry<F> | undefined;
  useEffect(() => {
    if (!uri) return;
    liveEntries.set(key, (liveEntries.get(key) || 0) + 1);
    const node = ref?.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;
    function load() {
      const wait = (entry?.until || 0) - Date.now();
      if (wait > 0) timer = setTimeout(load, Math.min(wait, 2 ** 31 - 1));
      else if (uri) request(key, uri, field, kind, !ref);
    }
    if (node && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(items => {
        if (items.some(item => item.isIntersecting)) load();
        else clearTimeout(timer);
      });
      observer.observe(node);
    } else load();
    return () => {
      observer?.disconnect();
      clearTimeout(timer);
      const count = liveEntries.get(key) || 0;
      if (count > 1) liveEntries.set(key, count - 1);
      else liveEntries.delete(key);
    };
  }, [key, uri, field, kind, ref, entry?.until]);
  return entry;
}

export function useLocalAlbumCover(uri?: string, stock?: string, ref?: RefObject<HTMLElement | null>): string {
  const data = useEntry(uri, 'cover', ref);
  return data?.blobUrl || albumart(data?.value?.url || stock);
}

export function useLocalAlbumInfo(uri?: string): AlbumInfo | undefined {
  return useEntry(uri, 'albumInfo')?.value;
}

export function useLocalArtistInfo(uri?: string, kind: 'album' | 'artist' = 'artist'): ArtistInfo | undefined {
  return useEntry(uri, 'artistInfo', undefined, kind)?.value;
}

export function usePlayingMusicUri(state?: { uri?: unknown; title?: unknown; album?: unknown; albumartist?: unknown; artist?: unknown }): string | undefined {
  const uri = localPlayingUri(state);
  const key = uri && state ? localPlayingAlbumKey(state, uri) : undefined;
  const [selection, setSelection] = useState({ key, uri });
  if (selection.key === key) return selection.uri;
  setSelection({ key, uri });
  return uri;
}
