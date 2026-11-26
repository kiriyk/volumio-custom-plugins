import { useEffect, useState } from 'react';
import { emit, on } from '../../core/socket';

type Selection = Record<string, string>;
type WaveState = { active: boolean; loading: boolean; error: string | null;
  selection: Selection; options: Record<string, { label: string; values: { value: string; label: string }[] }> };
const errors: Record<string, string> = { AUTH_REQUIRED: 'Войдите в Яндекс Музыку.', AUTH_EXPIRED: 'Войдите в Яндекс Музыку заново.', WAVE_EXPIRED: 'Сессия волны завершилась.', SERVICE_UNAVAILABLE: 'Яндекс Музыка недоступна.', UPSTREAM_TIMEOUT: 'Яндекс Музыка не ответила вовремя.', UNAVAILABLE: 'Нет доступных рекомендаций.', WAVE_QUEUE_CHANGED: 'Очередь изменилась.', ENGINE_ERROR: 'Ошибка воспроизведения.' };
const call = (method: string, data?: unknown) => emit('callMethod', { endpoint: 'music_service/yandex_music', method, data });

export default function YandexWave() {
  const [state, setState] = useState<WaveState | null>(null);
  const [draft, setDraft] = useState<Selection>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const off = on('pushYandexWave', (value: WaveState) => setState(value));
    const reconnect = on('connect', () => call('getWave'));
    call('getWave');
    return () => { off(); reconnect(); };
  }, []);
  useEffect(() => { if (state && !dirty) setDraft(state.selection); }, [state, dirty]);
  const start = () => { setDirty(false); call('startWave', { selection: draft }); };
  return <section className="aw-wave" aria-label="Моя волна" style={{ padding: '24px', maxWidth: 620, margin: '0 auto' }}>
    <h1>Моя волна</h1>
    <p role="status">{!state || state.loading ? 'Загрузка…' : state.active ? 'Волна играет' : 'Волна остановлена'}</p>
    {state?.error && <p role="alert">{errors[state.error] || 'Не удалось продолжить волну.'} Запустите волну снова.</p>}
    {Object.entries(state?.options || {}).map(([field, option]) => <label key={field} style={{ display: 'block', margin: '20px 0' }}>
      {option.label}
      <select className="form-control" style={{ width: '100%', marginTop: 8 }} value={draft[field] || ''}
        disabled={state?.loading} onChange={e => { setDirty(true); setDraft({ ...draft, [field]: e.target.value }); }}>
        <option value="">{field === 'activity' ? 'Моя волна' : 'По умолчанию'}</option>
        {option.values.map(value => <option key={value.value} value={value.value}>{value.label}</option>)}
      </select>
    </label>)}
    {state && <p>Применено: {Object.entries(state.selection).filter(([, value]) => value).map(([field, value]) =>
      state.options[field]?.values.find(option => option.value === value)?.label).filter(Boolean).join(', ') || 'Моя волна'}</p>}
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <button type="button" className="aw-wave__start" disabled={!state || state.loading || !Object.keys(state.options).length} onClick={start}>
        {state?.active ? 'Применить и перезапустить' : 'Запустить'}</button>
      <button type="button" className="aw-wave__stop" disabled={!state?.active && !state?.loading} onClick={() => call('stopWave')}>Остановить</button>
    </div>
  </section>;
}
