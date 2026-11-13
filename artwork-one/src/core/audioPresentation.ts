/** Presentation only: never replace controller fields or their saved values. */
const valueOf = (v: any) => v && typeof v === 'object' ? v.value : v;
export function audioPresentation(config: any, advanced = false) {
  const selection = (config?.sections || []).find((s: any) => s.id === 'selection');
  const field = (id: string) => (selection?.content || []).find((i: any) => i.id === id);
  const modeField = valueOf(field('engine')?.value) === 'album_player' ? 'albumMode' : 'mpdMode';
  const customSection = valueOf(field(modeField)?.value) === 'custom' ? (modeField === 'mpdMode' ? 'mpdCustom' : 'albumCustom') : null;
  const device = field('device');
  const selected = valueOf(device?.value);
  const options: any[] = device?.options || [];
  const missing = (o: any) => / — недоступно$/.test(String(o.label));
  const legacy = (o: any) => /\(совместимый\)$/.test(String(o.label));
  return {
    modeField, customSection,
    hasAdvanced: options.some(o => !missing(o) && legacy(o)),
    unavailable: options.find(o => o.value === selected && missing(o))?.label || null,
    options: options.filter(o => !missing(o) && (advanced || !legacy(o) || o.value === selected))
      .map(o => legacy(o) ? { ...o, label: 'HDMI, старый драйвер (вариант ' + (Number(String(o.value).split(':').pop()) + 1) + ')' } : o),
  };
}
export function audioSectionVisible(view: ReturnType<typeof audioPresentation>, id: string): boolean {
  return !['mpdCustom', 'albumCustom'].includes(id) || id === view.customSection;
}
export function audioFieldVisible(view: ReturnType<typeof audioPresentation>, section: string, id: string): boolean {
  return section !== 'selection' || !['mpdMode', 'albumMode'].includes(id) || id === view.modeField;
}
