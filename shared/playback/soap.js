'use strict';
const http = require('node:http');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
function error(code, soapCode) { return Object.assign(new Error(code), { code, ...(soapCode ? { soapCode } : {}) }); }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
function time(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw error('BAD_REQUEST');
  const n = Math.floor(ms); const pad = x => String(x).padStart(2, '0');
  return `${pad(Math.floor(n / 3600000))}:${pad(Math.floor(n / 60000) % 60)}:${pad(Math.floor(n / 1000) % 60)}.${String(n % 1000).padStart(3, '0')}`;
}
function milliseconds(value) {
  const m = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value || '');
  return m ? ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number((m[4] || '').padEnd(3, '0'))) : null;
}
class SoapClient {
  constructor(controlUrl, { timeoutMs = 15000 } = {}) {
    let url; try { url = new URL(controlUrl); } catch { throw error('BAD_ENGINE_CONFIG'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw error('BAD_ENGINE_CONFIG');
    this.url = url; this.timeoutMs = timeoutMs;
  }
  call(action, args = {}) {
    if (!/^[A-Za-z]+$/.test(action)) return Promise.reject(error('BAD_REQUEST'));
    const body = Buffer.from(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${SERVICE}">${Object.entries(args).map(([k, v]) => `<${k}>${escape(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`);
    return new Promise((resolve, reject) => {
      const req = http.request(this.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${SERVICE}#${action}"`, 'Content-Length': body.length } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) res.destroy(error('ENGINE_ERROR')); else chunks.push(chunk); });
        res.on('error', () => reject(error('ENGINE_UNAVAILABLE')));
        res.on('end', () => {
          try {
            const xml = Buffer.concat(chunks).toString('utf8');
            if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw error('ENGINE_ERROR');
            const body = parser.parse(xml)?.Envelope?.Body;
            if (body?.Fault) throw error('ENGINE_ERROR', String(body.Fault.detail?.UPnPError?.errorCode || 'unknown'));
            if (res.statusCode !== 200 || !body || !Object.hasOwn(body, `${action}Response`)) throw error('ENGINE_ERROR');
            resolve(body[`${action}Response`] || {});
          } catch (e) { reject(e.code ? e : error('ENGINE_ERROR')); }
        });
      });
      const deadline = setTimeout(() => req.destroy(error('ENGINE_UNAVAILABLE')), this.timeoutMs);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', () => reject(error('ENGINE_UNAVAILABLE')));
      req.end(body);
    });
  }
}
function metadata(url, track) {
  const mime = track.trackType === 'mp3' ? 'audio/mpeg' : track.trackType === 'mp4' ? 'audio/mp4' : 'audio/flac';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="${escape(track.uri)}" parentID="0" restricted="1"><dc:title>${escape(track.name || track.title || '')}</dc:title><dc:creator>${escape(track.artist || '')}</dc:creator><upnp:artist>${escape(track.artist || '')}</upnp:artist><upnp:album>${escape(track.album || '')}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:${mime}:*"${track.duration > 0 ? ` duration="${time(track.duration * 1000)}"` : ''}>${escape(url)}</res></item></DIDL-Lite>`;
}
module.exports = { SoapClient, metadata, milliseconds, time, error };
