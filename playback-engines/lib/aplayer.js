'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {fail} = require('./runtime');

const FORMATS = new Set(['.wav', '.flac', '.dsf', '.dff']);
const RESAMPLE_FIELDS = ['res_bf44', 'res44', 'res48', 'res88', 'res96', 'res176', 'res192', 'res352', 'res384'];
const PCM_RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];
const DSD_RATES = [352800, 705600, 1411200, 2822400];
const UPDATE_SOURCE = 'playback_engines';
const SHORT_TRACK_MS = 250;
const SHORT_EOF_TOLERANCE_MS = 20;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function aplayerSource(localStream, uri, valid) {
  if (typeof uri !== 'string' || !uri) throw fail('LOCAL_FILE_UNAVAILABLE');
  const legacy = /^cue:\/\/(.+\.cue)@(\d+)$/i.exec(uri);
  const parsed = legacy || /^(.*\.cue)\/track(\d{4})$/i.exec(uri);
  const ticket = parsed ? await localStream.cue.prepare(localStream, parsed[1], Number(parsed[2]) + (legacy ? 1 : 0), valid, {ordinal: true}) :
    await localStream.resolveFile(encodeURIComponent(uri));
  const suffix = path.extname(ticket.file).toLowerCase();
  if (!FORMATS.has(suffix)) throw fail('UNSUPPORTED_FORMAT');
  const {handle} = await localStream.openFile(ticket);
  await handle.close();
  return {ticket, suffix, open: () => localStream.openFile(ticket)};
}

function aplayerProfile(profile, bypass, source) {
  const dsd = source.encoding === 'dsd';
  const dsdMode = dsd ? (bypass ? 2 : profile.dsdMode) : 0;
  const dsdLimit = dsd ? DSD_RATES.indexOf(source.rate) : 0;
  if (dsd && dsdLimit < 0) throw fail('UNSUPPORTED_FORMAT');
  const pcmRateIndex = [44100, 88200, 176400, 352800].indexOf(profile.resampleRate || 44100);
  if (dsd && dsdMode === 0 && pcmRateIndex < 0) throw fail('APLAYER_RESAMPLE_UNAVAILABLE');
  if (dsdMode !== 0) {
    if (profile.resampleRate) throw fail('APLAYER_RESAMPLE_UNAVAILABLE');
    if (profile.forceBits || profile.downmix || profile.swapChannels || profile.phaseInvert ||
        profile.volumeEnabled || profile.convolverEnabled) throw fail('APLAYER_DSD_PROCESSING_UNAVAILABLE');
  }
  const patch = {
    gapless_mode: false, auto_mode: false, cue_mode: false, di_mode: 0, preload_mode: false,
    volume_enabled: profile.volumeEnabled, hw_volume: false, root_folder: '',
    dop_mode: dsdMode, dsd_limit: dsdLimit, enable_dsd: 0,
    pcm_freq: dsd && dsdMode === 0 ? pcmRateIndex : 0, dsd_vol: 0,
    mode_16bit: profile.forceBits === 16, mode_24bit: profile.forceBits === 24,
    multi_mode: profile.downmix, swap_mode: profile.swapChannels, phase_mode: profile.phaseInvert,
    use_conv: profile.convolverEnabled, conv_filter: profile.convolverEnabled ? profile.convolverFilter : 0,
    conv_db: profile.convolverEnabled ? Math.round(profile.convolverGain * 10) : 0
  };
  for (const field of RESAMPLE_FIELDS) patch[field] = dsd ? 0 : PCM_RATES.indexOf(profile.resampleRate);
  return {patch, dsdMode};
}

class AplayerTransport {
  constructor({runtime, sm, service, onError, verifyOutput, startupTimeoutMs = 8000}) {
    Object.assign(this, {runtime, sm, service, onError, verifyOutput, startupTimeoutMs});
    this.kind = 'aplayer';
    this.session = null;
    this.timer = null;
    this.commands = Promise.resolve();
  }

  activate() {
    return Promise.resolve(this.sm.setConsumeUpdateService(UPDATE_SOURCE, true, false)).then(() => {
      if (this.sm.consumeState) this.sm.consumeState.service = this.service;
    });
  }

  serialize(operation) {
    const run = this.commands.then(operation);
    this.commands = run.catch(() => {});
    return run;
  }

  owned(session) {
    return this.session === session && session.valid();
  }

  async playLocal(source, track, valid, owns) {
    const session = {valid, track, duration: 0, position: 0, observed: false};
    this.session = session;
    return this.serialize(async () => {
      if (!this.owned(session)) return false;
      await fs.mkdir(this.runtime.slot, {recursive: true, mode: 0o700});
      if (!(await fs.lstat(this.runtime.slot)).isDirectory()) throw fail('LOCAL_FILE_UNAVAILABLE');
      await this.runtime.clearSlot();
      const alias = path.join(this.runtime.slot, 'track-' + randomBytes(12).toString('hex') + source.suffix);
      const {handle} = await source.open();
      await handle.close();
      if (!this.owned(session)) return false;
      await fs.symlink(source.ticket.file, alias);
      session.duration = await this.load(alias, session);
      if (!this.owned(session)) return false;
      await this.activate();
      if (!this.owned(session)) return false;
      session.started = Date.now();
      await this.command('Play', {album: 0, song: 0});
      if (!this.owned(session)) return false;
      session.valid = owns;
      if (this.owned(session)) await this.poll(session);
      return true;
    });
  }

  async command(name, params) {
    const response = await this.runtime.request(name, params);
    if (response?.Result !== 'OK') throw fail('APLAYER_PLAYBACK_ERROR');
  }

  async load(alias, session) {
    let index = -1;
    let parentIndex = -1;
    for (let depth = 0; depth < 32 && this.owned(session); depth++) {
      const {Drives: entries} = await this.runtime.request('GetPlaylists', {ind: parentIndex});
      if (!Array.isArray(entries)) break;
      index = entries.findIndex(entry => entry?.path === this.runtime.slot);
      if (index !== -1) break;
      let longest = 0;
      parentIndex = -1;
      for (const [i, entry] of entries.entries()) {
        const candidate = entry?.path;
        if (typeof candidate === 'string' && !entry.expanded && candidate.length > longest &&
            this.runtime.slot.startsWith(candidate.replace(/\/$/, '') + '/')) {
          parentIndex = i;
          longest = candidate.length;
        }
      }
      if (parentIndex === -1) break;
    }
    if (!this.owned(session)) return 0;
    if (index === -1) throw fail('APLAYER_SCAN_FAILED');
    await this.command('GetPlaylist', {playlist: index});
    const deadline = Date.now() + 5000;
    while (this.owned(session) && Date.now() < deadline) {
      const state = await this.runtime.request('State');
      if (!state.Scanning && this.owned(session)) {
        const {Songs: albums} = await this.runtime.request('GetAlbums');
        const songs = albums?.[0];
        if (albums?.length === 1 && songs?.Songs?.length === 1 && this.owned(session)) {
          const result = await this.runtime.request('GetPath', {album: 0, song: 0});
          const duration = songs.SongsLen?.[0];
          if (result?.Path === alias && Number.isFinite(duration) && duration > 0) return duration;
        }
      }
      await delay(30);
    }
    if (!this.owned(session)) return 0;
    throw fail('APLAYER_SCAN_FAILED');
  }

  async consume(session, state) {
    if (!this.owned(session)) return;
    if (state.LastError || typeof state.Playing !== 'boolean') throw fail('APLAYER_PLAYBACK_ERROR');
    if (state.Album !== 0 || state.Song !== 0) throw fail('APLAYER_PLAYBACK_ERROR');
    const position = state.Position;
    if (!Number.isFinite(position) || position < 0) throw fail('APLAYER_PLAYBACK_ERROR');
    if (state.Playing || state.Paused) {
      if (!state.Paused && !session.observed) {
        // State can report Playing while ALSA is still opening the source.
        if (await this.verifyOutput() === false) {
          if (Date.now() - session.started >= this.startupTimeoutMs) throw fail('APLAYER_UNAVAILABLE');
          return;
        }
      }
      if (!this.owned(session)) return;
      session.observed ||= !state.Paused;
      session.paused = Boolean(state.Paused);
      session.position = position;
      await this.publish(session, state.Paused ? 'pause' : 'play', position);
    } else if (!session.observed) {
      if (Date.now() - session.started >= this.startupTimeoutMs) throw fail('APLAYER_UNAVAILABLE');
    } else {
      // The stopped State can retain a position just beyond the source duration.
      // Some files report zero after closing; keep the latest playing position.
      const reached = Math.max(position, session.position);
      const tolerance = session.duration <= SHORT_TRACK_MS
        ? Math.min(SHORT_EOF_TOLERANCE_MS, Math.ceil(session.duration / 5))
        : Math.min(250, Math.ceil(session.duration / 10));
      if (reached <= 0 || reached < session.duration - tolerance) throw fail('APLAYER_PLAYBACK_ERROR');
      await this.runtime.stop();
      if (!this.owned(session)) return;
      this.close();
      await this.publish(session, 'stop', session.duration);
    }
  }

  publish(session, status, position) {
    return this.sm.syncState({
      status, uri: session.track.uri, service: this.service, isStreaming: false,
      seek: Math.min(position, session.duration), duration: session.duration / 1000,
      trackType: session.track.trackType || path.extname(session.track.uri).slice(1)
    }, UPDATE_SOURCE);
  }

  async poll(session) {
    await this.consume(session, await this.runtime.request('State'));
    if (!this.owned(session)) {
      if (this.session === session) await this.stopPlayer();
      return;
    }
    // APlayer can retain a sampled position after EOF. Sample within its
    // measured 20 ms position step on short tracks; slow down while paused
    // or while waiting for a decoder that has not started.
    const short = session.duration <= SHORT_TRACK_MS &&
      (session.observed || Date.now() - session.started <= SHORT_TRACK_MS);
    const interval = session.paused ? 100 : short ? 5 :
      session.observed && session.duration - session.position > 250 ? 100 : 15;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.serialize(async () => {
        if (!this.owned(session)) {
          if (this.session === session) await this.stopPlayer();
          return;
        }
        await this.poll(session);
      }).catch(error => {
        if (this.owned(session)) this.onError(error);
      });
    }, interval);
    this.timer.unref?.();
  }

  async toggle(paused) {
    const session = this.session;
    if (!session) return;
    await this.serialize(async () => {
      if (!this.owned(session)) return;
      const state = await this.runtime.request('State');
      if (!this.owned(session)) return;
      if (state.LastError) throw fail('APLAYER_PLAYBACK_ERROR');
      if ((state.Playing || state.Paused) && Boolean(state.Paused) !== paused) await this.command('Pause');
    });
  }

  pause() { return this.toggle(true); }
  resume() { return this.toggle(false); }

  async seek(ms) {
    const session = this.session;
    if (!session || !Number.isFinite(ms)) return;
    await this.serialize(async () => {
      if (this.owned(session) && session.duration > 0) {
        await this.command('Position', {pos: Math.max(0, Math.min(100, ms * 100 / session.duration))});
      }
    });
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
    this.session = null;
  }

  async stopPlayer() {
    this.close();
    await this.runtime.stop();
  }

  stop() {
    this.close();
    return this.serialize(() => this.stopPlayer());
  }
}

module.exports = {AplayerTransport, aplayerSource, aplayerProfile};
