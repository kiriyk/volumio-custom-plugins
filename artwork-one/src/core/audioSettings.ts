/** Reuse controller sections verbatim: saves still go to its single settings store. */
export const ENGINE_PAGE = 'audio_interface/playback_engines';
export const AUDIO_PAGE = 'audio_interface/alsa_controller';
export function engineSettingsEnabled(plugins: any[]): boolean {
  return plugins.some(p => p?.category === 'audio_interface' && p.name === 'playback_engines' && (p.enabled === true || p.enabled === 'true'));
}
export function audioSettingsConfig(native: any, engine: any, enabled: boolean): any {
  if (!enabled) { return native; }
  if (!engine?.sections?.length) { return null; }
  return { ...engine, page: { ...engine.page, label: 'Аудио', description: 'Единые настройки выхода и профилей MPD и Album Player. Изменения применяются кнопками в соответствующем разделе. При отключении Playback Engines здесь доступны штатные настройки Volumio.' } };
}
export function settingsRequestPage(page: string, enabled: boolean): string {
  const normalized = page.includes('/') ? page : page.replace('-', '/');
  return enabled && normalized === AUDIO_PAGE ? ENGINE_PAGE : normalized;
}
