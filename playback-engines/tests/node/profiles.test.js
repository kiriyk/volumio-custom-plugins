'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let profiles;
try { profiles = require('../../lib/profiles'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

test('provides exact fresh settings and preserves independent inactive profiles', () => {
  assert.ok(profiles, 'profiles module is implemented');
  const first = profiles.defaults();
  assert.equal(first.engine, 'mpd');
  assert.deepEqual(first.modes, {mpd:'custom', album_player:'bypass'});
  first.custom.album_player.volume = 42;
  first.custom.mpd.resampleRate = 96000;
  const checked = profiles.validateSettings(first);
  checked.modes.mpd = 'bypass';
  const bypass = profiles.effectiveProfile(checked);
  assert.equal(bypass.volumeEnabled, false);
  assert.equal(bypass.resampleRate, 0);
  assert.equal(bypass.resampleBits, 0);
  checked.modes.mpd = 'custom';
  assert.equal(profiles.effectiveProfile(checked).resampleRate, 96000);
  checked.custom.album_player.volume = 70;
  assert.equal(first.custom.album_player.volume, 42);
  assert.equal(profiles.defaults().custom.album_player.volume, 80);
});

test('rejects incomplete, unknown, wrong typed, unsafe and out of range settings safely', () => {
  assert.ok(profiles);
  const invalid = [null, {}, [], 'secret input'];
  const mutate = fn => {const value = profiles.defaults(); fn(value); invalid.push(value);};
  mutate(s=>s.engine='other'); mutate(s=>s.extra=true); mutate(s=>s.version=2);
  mutate(s=>s.managed='yes'); mutate(s=>s.modes.mpd='other');
  mutate(s=>s.custom.mpd.volume=101); mutate(s=>s.custom.mpd.volume=-1);
  mutate(s=>s.custom.mpd.volume=NaN); mutate(s=>s.custom.mpd.volumeEnabled=1);
  mutate(s=>s.custom.mpd.resampleRate=12345); mutate(s=>s.custom.mpd.resampleBits=20);
  mutate(s=>s.custom.mpd.replaygain='loud'); mutate(s=>s.custom.mpd.crossfade=61);
  mutate(s=>s.custom.album_player.forceBits=32); mutate(s=>s.custom.album_player.dsdMode=3);
  mutate(s=>s.custom.album_player.convolverGain=Infinity);
  mutate(s=>s.device={key:'',label:'DAC'}); mutate(s=>s.device={key:'usb',label:'DAC',index:2});
  mutate(s=>s.custom.mpd.constructor='bad');
  for(const value of invalid) assert.throws(()=>profiles.validateSettings(value), error => error.code==='BAD_SETTINGS' && error.message==='Invalid playback settings');
});

test('maps Album Player profiles to native rate indexes and bypass flags', () => {
  assert.ok(profiles);
  const custom = profiles.defaults().custom.album_player;
  Object.assign(custom, {volumeEnabled:true,resampleRate:192000,forceBits:24,phaseInvert:true,swapChannels:true,downmix:true,convolverEnabled:true,convolverFilter:3,convolverGain:-2.5,dsdMode:1});
  const patch = profiles.albumPatch('custom', custom);
  assert.equal(patch.res44, 6); assert.equal(patch.res_bf44, 6); assert.equal(patch.res384, 6);
  assert.equal(patch.mode_24bit,true); assert.equal(patch.mode_16bit,false);
  assert.equal(patch.conv_db,-25); assert.equal(patch.dop_mode,1);
  assert.equal(patch.hw_volume,false); assert.equal(patch.volume_enabled,true);
  const bypass = profiles.albumPatch('bypass',custom);
  for(const key of ['volume_enabled','hw_volume','use_conv','mode_16bit','mode_24bit','phase_mode','swap_mode','multi_mode']) assert.equal(bypass[key],false,key);
  for(const key of ['res_bf44','res44','res48','res88','res96','res176','res192','res352','res384','enable_dsd']) assert.equal(bypass[key],0,key);
  assert.equal(custom.convolverEnabled,true);
});

test('filters renderer SetConfig payload to stock writable keys and disables shutdown', () => {
  assert.ok(profiles);
  const payload = profiles.albumPayload({gapless_mode:true,bframes:4096,volume_enabled:true,stat:'playing',asound:'secret',controlUrl:'bad',need_down:1}, {volume_enabled:false,unknown:1,need_down:1});
  assert.deepEqual(payload,{gapless_mode:true,bframes:4096,volume_enabled:false,need_down:0});
});

const config = '# audio_output { quoted "}"\n music_directory "/mnt/music"\nplaylist_directory "/data/playlists"\naudio_output_format "96000:24:2"\nreplaygain "album"\nreplaygain_preamp "6"\nvolume_normalization "yes"\naudio_output {\n type "alsa"\n name "DAC } # quote" # brace }\n device "default"\n mixer_type "hardware"\n format "48000:16:2"\n}\naudio_output { type "httpd"\n name "stream { # }"\n encoder "lame"\n}\naudio_output {\n type "alsa"\n device "hw:0"\n}\n';
test('replaces all ALSA blocks, respects comments and quoted braces, preserves library and nonALSA output', () => {
  assert.ok(profiles);
  const result = profiles.rewriteMpdConfig(config,'hw:CARD=DAC,DEV=0','bypass', profiles.defaults().custom.mpd);
  assert.match(result,/music_directory "\/mnt\/music"/);
  assert.match(result,/type "httpd"/); assert.match(result,/name "stream \{ # \}"/);
  assert.equal((result.match(/type "alsa"/g)||[]).length,1);
  assert.match(result,/name "Playback Engines"/); assert.match(result,/device "hw:CARD=DAC,DEV=0"/);
  assert.match(result,/mixer_type "none"/);
  assert.doesNotMatch(result,/audio_output_format|replaygain|volume_normalization|\n\s*format |crossfade|filter/);
  assert.equal(profiles.rewriteMpdConfig(result,'hw:CARD=DAC,DEV=0','bypass',profiles.defaults().custom.mpd),result);
});

test('writes explicit MPD custom processing without runtime crossfade or hardware mixer', () => {
  assert.ok(profiles);
  const custom = {...profiles.defaults().custom.mpd,volumeEnabled:true,resampleRate:96000,resampleBits:24,normalization:true,replaygain:'track',crossfade:4};
  const result = profiles.rewriteMpdConfig(config,'hw:CARD=USB_DAC,DEV=1','custom',custom);
  assert.match(result,/mixer_type "software"/); assert.match(result,/format "96000:24:\*"/);
  assert.match(result,/replaygain "track"/); assert.match(result,/volume_normalization "yes"/);
  assert.doesNotMatch(result,/crossfade|audio_output_format|replaygain_preamp/);
  for(const pcm of ['default','hw:0','hw:CARD=X,DEV=0"\nvolume "100','plughw:CARD=X,DEV=0']) assert.throws(()=>profiles.rewriteMpdConfig('',pcm,'bypass',custom),{code:'BAD_SETTINGS'});
  assert.throws(()=>profiles.rewriteMpdConfig('audio_output { type "alsa"','hw:CARD=X,DEV=0','bypass',custom),{code:'BAD_SETTINGS'});
});

test('accepts native convolver gain range and rejects values beyond it', () => {
  const settings = profiles.defaults();
  settings.custom.album_player.convolverGain = 60;
  assert.equal(profiles.validateSettings(settings).custom.album_player.convolverGain,60);
  for (const gain of [-60.1,60.1]) {
    settings.custom.album_player.convolverGain = gain;
    assert.throws(()=>profiles.validateSettings(settings), {code:'BAD_SETTINGS'});
  }
});
