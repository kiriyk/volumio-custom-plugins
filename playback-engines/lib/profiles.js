'use strict';

const RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];
const RES_FIELDS = ['res_bf44', 'res44', 'res48', 'res88', 'res96', 'res176', 'res192', 'res352', 'res384'];
// Stock renderer.js SaveConfig() fields, deliberately excluding GetConfig diagnostics.
const ALBUM_KEYS = ('gapless_mode preload_mode di_mode pframes bframes pmks bmks mode_16bit mode_24bit dop_mode pcm_freq volume_enabled lock_memory priority nice affinity_mode multi_mode swap_mode phase_mode ' + RES_FIELDS.join(' ') + ' soxr_phase soxr_filter soxr_quality std_buffer si_time mmap enable_dsd filter output rate level multithread need_down use_conv conv_filter conv_db hw_index hw_volume att ren_name ch_scr ch_tcp ip_scr pt_scr').split(' ');

function badSettings() {
  const error = new Error('Invalid playback settings');
  error.code = 'BAD_SETTINGS';
  return error;
}
function ensure(condition) { if (!condition) throw badSettings(); }
function defaults() {
  return {
    version: 1, managed: false, engine: 'mpd', device: null,
    modes: {mpd: 'custom', album_player: 'bypass'},
    custom: {
      mpd: {volumeEnabled: false, volume: 80, resampleRate: 0, resampleBits: 24, normalization: false, replaygain: 'off', crossfade: 0},
      album_player: {volumeEnabled: false, volume: 80, resampleRate: 0, forceBits: 0, phaseInvert: false, swapChannels: false, downmix: false, convolverEnabled: false, convolverFilter: 0, convolverGain: 0, dsdMode: 0}
    }
  };
}
function object(value, keys) {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  ensure(Reflect.ownKeys(value).length === keys.length);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value'));
  }
}
function integer(value, min, max) { ensure(Number.isInteger(value) && value >= min && value <= max); }
function bool(value) { ensure(typeof value === 'boolean'); }
function mode(value) { ensure(value === 'bypass' || value === 'custom'); }
function validateCustom(engine, value) {
  object(value, Object.keys(defaults().custom[engine]));
  bool(value.volumeEnabled); integer(value.volume, 0, 100);
  ensure(RATES.includes(value.resampleRate));
  if (engine === 'mpd') {
    ensure([16,24,32].includes(value.resampleBits));
    bool(value.normalization);
    ensure(['off','track','album','auto'].includes(value.replaygain));
    integer(value.crossfade, 0, 60);
  } else {
    ensure([0,16,24].includes(value.forceBits));
    for (const key of ['phaseInvert','swapChannels','downmix','convolverEnabled']) bool(value[key]);
    integer(value.convolverFilter, 0, 99);
    ensure(typeof value.convolverGain === 'number' && Number.isFinite(value.convolverGain) && value.convolverGain >= -60 && value.convolverGain <= 60);
    integer(value.dsdMode, 0, 2);
  }
}
function validateSettings(value) {
  object(value, Object.keys(defaults()));
  ensure(value.version === 1); bool(value.managed);
  ensure(value.engine === 'mpd' || value.engine === 'album_player');
  if (value.device !== null) {
    object(value.device, ['key','label']);
    for (const key of ['key','label']) ensure(typeof value.device[key] === 'string' && value.device[key].trim().length > 0 && value.device[key].length <= 1024 && !/[\x00-\x1f\x7f]/.test(value.device[key]));
  }
  object(value.modes, ['mpd','album_player']);
  object(value.custom, ['mpd','album_player']);
  for (const engine of ['mpd','album_player']) {mode(value.modes[engine]); validateCustom(engine, value.custom[engine]);}
  return JSON.parse(JSON.stringify(value));
}
function effectiveProfile(settings) {
  const value = validateSettings(settings);
  const profile = value.custom[value.engine];
  if (value.modes[value.engine] === 'custom') return profile;
  if (value.engine === 'mpd') return {...profile, volumeEnabled:false, resampleRate:0, resampleBits:0, normalization:false, replaygain:'off', crossfade:0};
  return {...profile, volumeEnabled:false, resampleRate:0, forceBits:0, phaseInvert:false, swapChannels:false, downmix:false, convolverEnabled:false, dsdMode:0};
}
function albumPatch(selectedMode, custom) {
  mode(selectedMode); validateCustom('album_player', custom);
  const enabled = selectedMode === 'custom';
  const patch = {
    volume_enabled: enabled && custom.volumeEnabled, hw_volume:false,
    mode_16bit: enabled && custom.forceBits === 16,
    mode_24bit: enabled && custom.forceBits === 24,
    phase_mode:enabled && custom.phaseInvert, swap_mode:enabled && custom.swapChannels,
    multi_mode:enabled && custom.downmix, use_conv:enabled && custom.convolverEnabled,
    conv_filter:enabled ? custom.convolverFilter : 0,
    conv_db:enabled ? Math.round(custom.convolverGain * 10) : 0,
    dop_mode:enabled ? custom.dsdMode : 0, enable_dsd:0
  };
  for (const key of RES_FIELDS) patch[key] = enabled ? RATES.indexOf(custom.resampleRate) : 0;
  return patch;
}
function albumPayload(current, patch) {
  const result = {};
  for (const source of [current, patch]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of ALBUM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source,key)) result[key] = source[key];
    }
  }
  result.need_down = 0;
  return result;
}

// Token positions allow changes without reformatting unrelated MPD configuration.
// Comments and quoted strings never participate in brace balancing.
function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const start = index;
    const char = text[index++];
    if (char === '#') { while (index < text.length && text[index] !== '\n') index++; continue; }
    if (char === '\n') {tokens.push({value:'\n',start,end:index}); continue;}
    if (/\s/.test(char)) continue;
    if (char === '{' || char === '}') {tokens.push({value:char,start,end:index}); continue;}
    if (char === '"' || char === "'") {
      let value = '', closed = false;
      while (index < text.length) {
        const next = text[index++];
        if (next === char) {closed = true; break;}
        if (next === '\\') {ensure(index < text.length); value += text[index++];} else value += next;
      }
      ensure(closed); tokens.push({value,start,end:index,quoted:true}); continue;
    }
    while (index < text.length && !/[\s{}#"']/.test(text[index])) index++;
    tokens.push({value:text.slice(start,index),start,end:index});
  }
  return tokens;
}
function rewriteMpdConfig(text, pcm, selectedMode, custom) {
  ensure(typeof text === 'string');
  ensure(typeof pcm === 'string' && /^hw:CARD=[A-Za-z0-9_-]+,DEV=\d+$/.test(pcm));
  mode(selectedMode); validateCustom('mpd',custom);
  const tokens = tokenize(text), removals = [];
  const unsafe = new Set(['audio_output_format','volume_normalization','replaygain','replaygain_preamp','replaygain_missing_preamp','replaygain_limit','crossfade','audio_filter','resampler']);
  const nextValue = start => {while (start < tokens.length && tokens[start].value === '\n') start++; return start;};
  const addRemoval = (start,end) => {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^\s*$/.test(text.slice(lineStart,start))) start = lineStart;
    const lineEnd = text.indexOf('\n',end);
    const after = text.slice(end,lineEnd < 0 ? text.length : lineEnd);
    if (/^\s*(?:#.*)?$/.test(after)) end = lineEnd < 0 ? text.length : lineEnd + 1;
    removals.push({start,end});
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === '\n') continue;
    ensure(!token.quoted && token.value !== '{' && token.value !== '}');
    const following = nextValue(i+1);
    if (tokens[following] && !tokens[following].quoted && tokens[following].value === '{') {
      let depth = 1, end = following + 1, alsa = false;
      for (; end < tokens.length && depth; end++) {
        const current = tokens[end];
        if (current.quoted) continue;
        if (current.value === '{') depth++;
        else if (current.value === '}') depth--;
        else if (depth === 1 && current.value === 'type') {
          const type = tokens[nextValue(end+1)];
          if (type && type.value === 'alsa') alsa = true;
        }
      }
      ensure(depth === 0);
      if ((token.value === 'audio_output' && alsa) || unsafe.has(token.value)) addRemoval(token.start,tokens[end-1].end);
      i = end-1;
    } else {
      let end = i+1;
      while (end < tokens.length && tokens[end].value !== '\n') {
        ensure(tokens[end].quoted || (tokens[end].value !== '{' && tokens[end].value !== '}')); end++;
      }
      if (unsafe.has(token.value)) addRemoval(token.start,end < tokens.length ? tokens[end].start : text.length);
      i = end;
    }
  }
  let output = '', cursor = 0;
  for (const removal of removals) {output += text.slice(cursor,removal.start); cursor = removal.end;}
  output += text.slice(cursor);
  output = output.trimEnd();
  const enabled = selectedMode === 'custom';
  const lines = ['audio_output {','    type "alsa"','    name "Playback Engines"','    device "' + pcm + '"','    mixer_type "' + (enabled && custom.volumeEnabled ? 'software' : 'none') + '"'];
  if (enabled && custom.resampleRate) lines.push('    format "' + custom.resampleRate + ':' + custom.resampleBits + ':*"');
  lines.push('}');
  if (enabled) lines.push('replaygain "' + custom.replaygain + '"','volume_normalization "' + (custom.normalization ? 'yes' : 'no') + '"');
  return (output ? output + '\n' : '') + lines.join('\n') + '\n';
}

module.exports = {defaults, validateSettings, effectiveProfile, albumPatch, albumPayload, rewriteMpdConfig};
