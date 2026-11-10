/**
 * The playback state, as the player pushes it, plus the clock that runs between pushes.
 *
 * `pushState` carries the seek position at that moment; while the status is `play` the store
 * advances its own elapsed time every 250 ms, exactly as the Angular player service did, and a
 * new push resets it. Everything a screen reads about the current track comes from here.
 */
import { create } from 'zustand';
import { on, emit } from '../socket';
import type { PlayerState } from '../format';
import { actualYandexQuality as actualStreamQuality } from '../yandexQuality';

const TICK = 250;

interface Favourite { favourite: boolean; service?: string; uri?: string }

interface PlayerStore {
  state: PlayerState;
  elapsedMs: number;
  favourite: Favourite;
  ready: boolean;
  // transport
  play: () => void;
  pause: () => void;
  stop: () => void;
  togglePlay: () => void;
  prev: () => void;
  next: () => void;
  seekTo: (seconds: number) => void;
  shuffle: () => void;
  repeat: (repeat: boolean, single: boolean) => void;
  cycleRepeat: () => void;
  setVolume: (v: number) => void;
  volumeUp: () => void;
  volumeDown: () => void;
  toggleMute: () => void;
  toggleFavourite: () => void;
}

let timer: number | null = null;
let streamQuality: { uri: string; codec: string; sampleRate?: number; bitDepth?: number } | null = null;
let qualityRequestUri = '';

export const usePlayer = create<PlayerStore>((set, get) => ({
  state: {},
  elapsedMs: 0,
  favourite: { favourite: false },
  ready: false,

  play: () => { const st = get().state; emit(st.volatile ? 'volatilePlay' : 'play'); },
  pause: () => emit('pause'),
  stop: () => emit('stop'),
  togglePlay: () => {
    const st = get().state;
    if (st.status === 'play') { if (st.trackType === 'webradio') { emit('stop'); } else { emit('pause'); } }
    else { get().play(); }
  },
  prev: () => emit('prev'),
  next: () => emit('next'),
  seekTo: (seconds) => { emit('seek', Math.max(0, Math.round(seconds))); set({ elapsedMs: seconds * 1000 }); },
  shuffle: () => emit('setRandom', { value: !get().state.random }),
  repeat: (repeat, single) => emit('setRepeat', { value: repeat, repeatSingle: single }),
  cycleRepeat: () => {
    const st = get().state;
    if (!st.repeat) { get().repeat(true, false); }
    else if (!st.repeatSingle) { get().repeat(true, true); }
    else { get().repeat(false, false); }
  },
  setVolume: (v) => emit('volume', Math.max(0, Math.min(100, Math.round(v)))),
  volumeUp: () => emit('volume', '+'),
  volumeDown: () => emit('volume', '-'),
  toggleMute: () => emit(get().state.mute ? 'unmute' : 'mute'),
  toggleFavourite: () => {
    const { favourite, state } = get();
    if (!state.uri) { return; }
    emit(favourite.favourite ? 'removeFromFavourites' : 'addToFavourites', { service: state.service, uri: state.uri, title: state.title, artist: state.artist, album: state.album, albumart: state.albumart });
  },
}));

function stopClock() { if (timer !== null) { window.clearInterval(timer); timer = null; } }
function startClock() {
  stopClock();
  timer = window.setInterval(() => {
    const { state, elapsedMs } = usePlayer.getState();
    const dur = (state.duration || 0) * 1000;
    const next = elapsedMs + TICK;
    // the clock stops at the end: the player says what comes after
    usePlayer.setState({ elapsedMs: dur && next > dur ? dur : next });
  }, TICK);
}

on('pushState', (data: PlayerState) => {
  const st = { ...(data || {}) };
  if (['yandex_music', 'qobuz_custom'].includes(st.service || '') && st.uri) {
    delete st.bitrate;
    if (streamQuality?.uri === st.uri) {
      Object.assign(st, actualStreamQuality(streamQuality));
    } else if (qualityRequestUri !== st.uri) {
      qualityRequestUri = st.uri;
      emit('callMethod', { endpoint: `music_service/${st.service}`, method: 'getPlaybackQuality' });
    }
  } else { qualityRequestUri = ''; streamQuality = null; }
  st.disableUi = !!st.disableUiControls || st.service === 'analogin';
  usePlayer.setState({ state: st, elapsedMs: (st.seek || 0), ready: true });
  if (st.status === 'play') { startClock(); } else { stopClock(); }
  // the page's own title: what plays, the way Volumio's interface does it; the tab's icon turns green while music plays
  try {
    document.title = st.title ? `${st.title}${st.artist ? ' · ' + st.artist : ''}` : 'Volumio';
    const icon = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    const href = st.status === 'play' ? '/favicon-playing.svg' : '/favicon.svg';
    if (icon && icon.getAttribute('href') !== href) { icon.setAttribute('href', href); }
  } catch { /* no document */ }
});
function acceptStreamQuality(info: any, service: string) {
  if (!info || typeof info.uri !== 'string' || !['flac', 'flac-mp4', 'mp3'].includes(info.codec)) { return; }
  const state = usePlayer.getState().state;
  if (state.service !== service || state.uri !== info.uri) { return; }
  streamQuality = { uri: info.uri, codec: info.codec, sampleRate: info.sampleRate, bitDepth: info.bitDepth };
  usePlayer.setState({ state: { ...state, ...actualStreamQuality(info) } });
}
on('pushYandexQuality', (info: any) => acceptStreamQuality(info, 'yandex_music'));
on('pushQobuzCustomQuality', (info: any) => acceptStreamQuality(info, 'qobuz_custom'));
on('urifavourites', (data: Favourite) => usePlayer.setState({ favourite: data || { favourite: false } }));

emit('getState');
