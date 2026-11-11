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
module.exports = { createTransport, createTransportFromFile, MpdTransport, AlbumPlayerTransport, SoapClient };
