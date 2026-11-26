'use strict';
const VolumioQueue = require('./volumio-queue');
const { mapTrack } = require('./track-mapper');
const { performance } = require('node:perf_hooks');

class Wave {
  constructor(api, router) {
    this.api = api; this.router = router; this.sm = router.stateMachine;
    this.queueAdapter = new VolumioQueue(this.sm, router.logger);
    this.serial = Promise.resolve(); this.generation = 0; this.active = false;
    this.loading = false; this.error = null; this.selection = {}; this.options = {};
    this.expected = []; this.tracks = new Map(); this.session = null; this.current = null; this.sequence = 0;
    this.feedback = Promise.resolve(); this.mutating = false; this.refilling = false;
    this.hooks = []; this.navigationDepth = 0; this.ownControlDepth = 0; this.navigating = false; this.advancing = false;
    for (const method of ['next', 'previous', 'stop', 'seek', 'pause']) {
      if (typeof this.sm[method] !== 'function') continue;
      const original = this.sm[method], wave = this;
      const wrapped = function (...args) {
        if (method === 'seek' || method === 'pause') {
          if (wave.active) {
            wave.accountTime(wave.sm.getState());
            if (wave.current) wave.current.playing = false;
          }
          return original.apply(this, args);
        }
        if (method === 'stop') {
          if ((wave.active || wave.loading) && !wave.ownControlDepth && !wave.navigationDepth) {
            wave.navigating = false; wave.advancing = false; void wave.stop(false);
          }
          return original.apply(this, args);
        }
        if (wave.active) {
          wave.accountTime(wave.sm.getState());
          if (wave.current) wave.current.playing = false;
          wave.navigating = true; wave.navigationMethod = method;
        }
        wave.navigationDepth++;
        try { return original.apply(this, args); }
        finally { wave.navigationDepth--; }
      };
      this.sm[method] = wrapped;
      this.hooks.push(() => { if (this.sm[method] === wrapped) this.sm[method] = original; });
    }
    this.stateCallback = state => { this.observe(state); };
    router.addCallback?.('volumioPushState', this.stateCallback);
    this.timer = setInterval(() => this.enqueue(() => this.check()).catch(e => this.fail(e)), 2000);
    this.timer.unref?.();
  }
  ownControl(operation) {
    this.ownControlDepth++;
    try { return operation(); } finally { this.ownControlDepth--; }
  }
  enqueue(fn) { const result = this.serial.then(fn); this.serial = result.catch(() => {}); return result; }
  publish() {
    const state = { active: this.active, loading: this.loading, error: this.error,
      selection: this.selection, options: this.options };
    this.router.broadcastMessage('pushYandexWave', state); return state;
  }
  async get() {
    try { Object.assign(this, await this.api.request('GET', '/v1/wave')); }
    catch (e) { if (this.active) await this.fail(e); else this.error = this.errorCode(e); }
    return this.publish();
  }
  errorCode(error) { const code = error.code || error.message; return /^[A-Z_]+$/.test(code) ? code : 'WAVE_ERROR'; }
  queue() { return this.sm.getQueue().map(track => track.uri); }
  owns() { return JSON.stringify(this.queue()) === JSON.stringify(this.expected); }
  start(selection) {
    const generation = ++this.generation; this.active = false;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      this.starting = true; this.loading = true; this.error = null; this.publish();
      try {
        await this.finishSession();
        const batch = await this.api.request('POST', '/v1/wave/start', { selection });
        if (generation !== this.generation) {
          await this.api.request('POST', '/v1/wave/end', { id: batch.id }); return;
        }
        if (!batch.items?.length) throw new Error('UNAVAILABLE');
        const tracks = batch.items.map(mapTrack);
        this.tracks = new Map(tracks.map(track => [track.uri, track]));
        this.mutating = true;
        this.savedModes = { random: this.sm.currentRandom, repeat: this.sm.currentRepeat,
          single: this.sm.currentRepeatSingleSong };
        this.sm.setRandom(false); this.sm.setRepeat(false, false);
        this.session = batch.id;
        await this.ownControl(() => this.sm.stop());
        if (generation !== this.generation) return;
        await this.ownControl(() => this.queueAdapter.clear());
        if (generation !== this.generation) return;
        await this.sm.addQueueItems(tracks);
        if (generation !== this.generation) return;
        this.expected = tracks.map(t => t.uri);
        this.batchNumber = 1; this.trackBatches = new Map(this.expected.map(uri => [uri, 1]));
        if (!this.owns()) throw new Error('WAVE_QUEUE_CHANGED');
        this.session = batch.id; this.selection = batch.selection; this.active = true;
        this.current = null;
        this.sm.currentPosition = 0;
        await this.sm.play();
      } catch (e) { this.router.logger?.error('[yandex wave] ' + e.stack); await this.finishSession(); this.error = this.errorCode(e); }
      finally { this.starting = false; this.mutating = false; this.loading = false; this.publish(); }
    });
  }
  stop(stopPlayback = true) {
    ++this.generation; this.active = false;
    return this.enqueue(async () => {
      await this.finishSession();
      if (stopPlayback) await this.ownControl(() => this.sm.stop());
      this.publish();
    });
  }
  async finishSession() {
    this.active = false; this.current = null; this.tracks.clear(); this.navigating = false; this.advancing = false;
    const id = this.session; this.session = null;
    await this.feedback;
    try { if (id) await this.api.request('POST', '/v1/wave/end', { id }); }
    catch (error) { this.error = this.errorCode(error); }
    finally {
      if (this.savedModes) {
        const modes = this.savedModes; this.savedModes = null;
        this.sm.setRandom(modes.random); this.sm.setRepeat(modes.repeat, modes.single);
      }
    }
  }
  fail(error) {
    ++this.generation; this.active = false;
    return this.enqueue(async () => {
      try { await this.finishSession(); }
      catch { /* report the original operation error */ }
      this.loading = false; this.error = this.errorCode(error); this.publish();
    });
  }
  emit(event, current = this.current) {
    if (!current || !this.session || (event !== 'trackStarted' && current.terminal)) return;
    if (event !== 'trackStarted') current.terminal = true;
    const id = this.session;
    const data = { id, event, track_id: current.id, occurrence: current.occurrence, seconds: current.seconds };
    this.feedback = this.feedback.then(() => this.api.request('POST', '/v1/wave/event', data))
      .catch(e => { if (this.session === id) void this.fail(e); });
  }
  accountTime(state) {
    if (!this.current) return;
    const now = performance.now(), seek = Number(state.seek), last = this.current;
    const elapsed = (now - last.at) / 1000;
    // A seek is not listening. Both samples must describe continuous playback.
    if (last.playing && ['play', 'pause'].includes(state.status) && state.uri === last.uri &&
        Number.isFinite(seek) && Math.abs((seek - last.seek) / 1000 - elapsed) < 2)
      last.seconds += elapsed;
    last.at = now; last.seek = seek; last.playing = state.status === 'play';
  }
  ended(track) {
    if (!this.active || this.navigating || this.current?.uri !== track.uri) return;
    this.accountTime({ uri: track.uri, status: 'play', seek: this.sm.getState().seek });
    this.advancing = this.sm.currentPosition + 1 < this.expected.length;
    this.emit('trackFinished');
  }
  observe(state) {
    if (!this.active || this.starting) return;
    if ((!this.mutating && !this.owns()) || state.random || state.repeat || state.volatile || this.sm.isVolatile || this.sm.isUpnp) {
      void this.stop(false); return;
    }
    const restarted = this.current && Number(state.seek) < this.current.seek;
    this.accountTime(state);
    if (state.status === 'stop') { if (this.current && !this.navigating && !this.advancing) void this.stop(false); return; }
    if (state.service !== 'yandex_music') { void this.stop(false); return; }
    const restartedPrevious = this.navigating && this.navigationMethod === 'previous' && restarted &&
      !this.current?.terminal && this.expected[this.sm.currentPosition] === this.current?.uri && this.sm.currentStatus === 'play';
    if (state.status === 'play' && (state.uri !== this.current?.uri || restartedPrevious)) {
      this.navigating = false; this.advancing = false;
    }
    if (state.status === 'play' && this.current?.uri !== state.uri) {
      if (this.current && !this.current.terminal) this.emit('skip');
      const id = decodeURIComponent(String(state.uri).split('/').pop()).split(':')[0];
      this.current = { id, uri: state.uri, occurrence: String(++this.sequence), seconds: 0,
        at: performance.now(), seek: Number(state.seek), playing: true, terminal: false };
      this.emit('trackStarted');
    }
    void this.enqueue(() => this.check()).catch(e => this.fail(e));
  }
  async check() {
    if (!this.active || this.mutating) return;
    if (!this.owns()) { ++this.generation; await this.finishSession(); this.publish(); return; }
    const generation = this.generation, id = this.session;
    const valid = () => this.active && generation === this.generation && this.session === id && this.owns();
    this.mutating = true;
    try {
      while (this.sm.currentPosition > 20) {
        if (!valid()) return;
        const removed = this.expected.shift();
        this.trackBatches.delete(removed); this.tracks.delete(removed);
        await this.queueAdapter.removePast();
        if (!this.owns()) throw new Error('WAVE_QUEUE_CHANGED');
      }
    } finally { this.mutating = false; }
    if (this.expected.length - this.sm.currentPosition - 1 > 2 || this.refilling) return;
    const futureBatches = new Set(this.expected.slice(this.sm.currentPosition + 1).map(uri => this.trackBatches.get(uri)));
    if (futureBatches.size >= 2) return;
    this.refilling = true;
    try {
      const batch = await this.api.request('POST', '/v1/wave/next', { id });
      if (!valid()) return;
      if (!batch.items?.length) throw new Error('UNAVAILABLE');
      this.mutating = true;
      const tracks = batch.items.map(mapTrack);
      this.batchNumber++;
      for (const track of tracks) {
        this.trackBatches.set(track.uri, this.batchNumber); this.tracks.set(track.uri, track);
      }
      this.expected.push(...tracks.map(t => t.uri));
      await this.sm.addQueueItems(tracks);
      if (!this.owns()) throw new Error('WAVE_QUEUE_CHANGED');
    } finally { this.mutating = false; this.refilling = false; }
  }
  async close() {
    clearInterval(this.timer);
    while (this.hooks.length) this.hooks.pop()();
    const callbacks = this.router.callbacks?.volumioPushState;
    if (callbacks) { const index = callbacks.indexOf(this.stateCallback); if (index >= 0) callbacks.splice(index, 1); }
    await this.stop(false);
  }
}
module.exports = Wave;
