/** Display only the manager's actual selection; bypass flags do not verify PCM equality. */
export interface PlaybackEngineState {
  managed: boolean;
  engine?: string;
  mode?: string;
  ready?: boolean;
  volumeEnabled?: boolean;
  device?: { label: string };
  observation?: { state: string; actualEngine: string | null; routeMatches: boolean | null };
}
export function playbackEngineView(state: PlaybackEngineState | null) {
  if (!state?.managed) return null;
  const requested = state.engine === 'album_player' ? 'Album Player' : 'MPD';
  const o = state.observation;
  const actual = o?.actualEngine === 'album_player' ? 'Album Player' : o?.actualEngine === 'mpd' ? 'MPD' : '';
  let engineLabel = `Выбран ${requested} · не подтверждён`;
  if (o?.state === 'mismatch') engineLabel = `${actual || requested} · несовпадение${actual !== requested ? ' · выбран ' + requested : ''}`;
  else if (o?.state === 'idle') engineLabel = `Выбран ${requested} · PCM закрыт`;
  else if (o?.state === 'unavailable') engineLabel = `Выбран ${requested} · выход недоступен`;
  else if (actual && o?.routeMatches === false) engineLabel = `${actual} · выбран ${requested}`;
  else if (actual && o?.routeMatches && o?.state === 'running') engineLabel = `${actual} · ALSA`;
  else if (actual && o?.routeMatches) engineLabel = `${actual} · PCM открыт`;
  return {
    engineLabel,
    engine: state.engine === 'album_player' ? 'Album Player' : 'MPD',
    output: (state.device?.label || 'Аудиовыход') + (state.ready ? '' : ' · недоступно'),
    processing: o?.state === 'mismatch' ? 'OUTPUT MISMATCH' : state.mode === 'bypass' ? 'NO PROCESSING' : 'CUSTOM PROCESSING',
    bitPerfect: false,
  };
}
