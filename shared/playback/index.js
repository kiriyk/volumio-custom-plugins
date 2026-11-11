'use strict';
const fs = require('node:fs');
const MpdTransport = require('./mpd');
const AlbumPlayerTransport = require('./album-player');
const { SoapClient, error } = require('./soap');
function createTransport(options = {}) {
  const config = options.config === undefined ? {} : options.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw error('BAD_ENGINE_CONFIG');
  if (config.engine === undefined || config.engine === 'mpd') return new MpdTransport(options);
  if (config.engine !== 'album_player') throw error('BAD_ENGINE_CONFIG');
  return new AlbumPlayerTransport({ ...options, client: options.client || new SoapClient(config.controlUrl) });
}
function createTransportFromFile(filename, options = {}) {
  let config;
  if (filename) {
    try { config = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw error('BAD_ENGINE_CONFIG'); }
  }
  return createTransport({ ...options, config });
}
// Resolve the plugin at play time: sources may have started while it was disabled.
function createTransportWithManager(filename, options = {}) {
  let fallback, owner, managed, active;
  const native = () => fallback ||= createTransportFromFile(filename, options);
  const select = () => {
    const manager = options.getManager?.();
    if (!manager?.getTransport) return native();
    if (owner !== manager) { managed?.close(); owner = manager; managed = manager.getTransport(options.service, options.onError); }
    return managed;
  };
  return {
    get kind() { return active?.kind || 'mpd'; },
    play: (...args) => { active = select(); return active.play(...args); },
    activate: () => active?.activate?.() || Promise.resolve(),
    pause: () => active?.pause?.() || Promise.resolve(),
    resume: () => active?.resume?.() || Promise.resolve(),
    seek: ms => active?.seek?.(ms) || Promise.resolve(),
    stop: () => active?.stop?.() || Promise.resolve(),
    close: () => { managed?.close(); fallback?.close(); active = null; },
  };
}
module.exports = { createTransportWithManager, createTransport, createTransportFromFile, MpdTransport, AlbumPlayerTransport, SoapClient };
