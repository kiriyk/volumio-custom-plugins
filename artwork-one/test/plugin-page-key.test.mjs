import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageKey } from '../src/core/pluginPageKey.ts';

test('repeated normalization retains the GPIO plugin name instead of requesting a core section', () => {
  const route = pageKey('system_hardware-gpio-buttons');
  assert.equal(route, 'system_hardware/gpio-buttons');
  assert.equal(pageKey(route), 'system_hardware/gpio-buttons');
  assert.equal(pageKey('audio_interface-playback_engines'), 'audio_interface/playback_engines');
  assert.equal(pageKey('system_hardware/gpio-buttons'), 'system_hardware/gpio-buttons');
  assert.equal(pageKey('system_controller/system/version'), 'system_controller/system/version');
});
