import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioSettingsConfig, engineSettingsEnabled } from '../src/core/audioSettings.ts';

test('enabled controller supplies audio settings with original save endpoints and objects', () => {
  const section = { id:'selection', onSave:{endpoint:'audio_interface/playback_engines',method:'saveSelection'}, content:[{id:'device',value:'usb'}] };
  const engine = {page:{label:'Движки'},sections:[section]};
  const merged = audioSettingsConfig({sections:[{id:'volume_options'}]}, engine, true);
  assert.equal(merged.page.label, 'Аудио');
  assert.equal(merged.sections[0], section);
  assert.deepEqual(merged.sections.map(s=>s.id), ['selection']);
});
test('disabled or absent plugin keeps native audio settings; unavailable enabled controller cannot expose competing controls', () => {
  const native = {sections:[{id:'volume_options'}]};
  assert.equal(audioSettingsConfig(native,null,false), native);
  assert.equal(audioSettingsConfig(native,null,true), null);
  assert.equal(engineSettingsEnabled([{name:'playback_engines',category:'audio_interface',enabled:'true'}]), true);
  assert.equal(engineSettingsEnabled([{name:'playback_engines',category:'audio_interface',enabled:'false'}]), false);
  assert.equal(engineSettingsEnabled([]), false);
});
test('settings search requests the controller behind Audio only while enabled', async () => {
  const { settingsRequestPage } = await import('../src/core/audioSettings.ts');
  assert.equal(settingsRequestPage('audio_interface/alsa_controller', true), 'audio_interface/playback_engines');
  assert.equal(settingsRequestPage('audio_interface-alsa_controller', false), 'audio_interface/alsa_controller');
  assert.equal(settingsRequestPage('system_hardware/gpio-buttons', true), 'system_hardware/gpio-buttons');
});
