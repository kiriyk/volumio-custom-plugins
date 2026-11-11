/** Display only the manager's actual selection; bypass flags do not verify PCM equality. */
export interface PlaybackEngineState {
  managed: boolean;
  engine?: string;
  mode?: string;
  ready?: boolean;
  volumeEnabled?: boolean;
  device?: { label: string };
}
export function playbackEngineView(state: PlaybackEngineState | null) {
  if (!state?.managed) return null;
  return {
    engine: state.engine === 'album_player' ? 'Album Player' : 'MPD',
    output: (state.device?.label || 'Аудиовыход') + (state.ready ? '' : ' · недоступно'),
    processing: state.mode === 'bypass' ? 'NO PROCESSING' : 'CUSTOM PROCESSING',
    bitPerfect: false,
  };
}
