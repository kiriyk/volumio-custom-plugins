'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const UNIT = 'volumio-playback-renderer.service';
const fail = code => Object.assign(new Error(code), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
function pcmParts(pcm) {
  const m = /^hw:CARD=([A-Za-z0-9_-]+),DEV=(\d{1,3})$/.exec(pcm || '');
  if (!m) throw fail('INVALID_DEVICE');
  return { card: m[1], device: Number(m[2]) };
}
class Runtime {
  constructor({ stateDir, run = execFile, helper = path.join(__dirname, '../service/devices.py'), mpdPort = 6600 }) {
    Object.assign(this, { stateDir, run, helper, mpdPort }); this.endpoints = null;
  }
  async helperCall(args, timeout = 6000) {
    try {
      const { stdout } = await this.run('/usr/bin/python3', [this.helper, ...args], { timeout, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (e) {
      try { const result = JSON.parse(e.stdout); throw fail(result.error || 'DEVICE_ERROR'); }
      catch (parsed) { throw parsed.code ? parsed : fail('DEVICE_ERROR'); }
    }
  }
  devices() { return this.helperCall(['devices']); }
  mpdRaw(command) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.mpdPort });
      let buffer = '', greeted = false; const lines = [];
      const timer = setTimeout(() => socket.destroy(fail('MPD_UNAVAILABLE')), 4000);
      socket.on('data', chunk => {
        buffer += chunk.toString();
        while (buffer.includes('\n')) {
          const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (!greeted) { if (!line.startsWith('OK MPD ')) return socket.destroy(fail('MPD_UNAVAILABLE')); greeted = true; socket.write(command + '\n'); }
          else if (line === 'OK') { clearTimeout(timer); socket.end(); resolve(lines); }
          else if (line.startsWith('ACK ')) socket.destroy(fail('MPD_UNAVAILABLE'));
          else lines.push(line);
        }
      });
      socket.on('error', () => reject(fail('MPD_UNAVAILABLE')));
      socket.on('close', () => { clearTimeout(timer); reject(fail('MPD_UNAVAILABLE')); });
    });
  }
  async outputPolicy(engine) {
    const lines = await this.mpdRaw('outputs'); const outputs = []; let current;
    for (const line of lines) {
      const [key, ...rest] = line.split(': '), value = rest.join(': ');
      if (key === 'outputid') { current = { id: Number(value) }; outputs.push(current); }
      else if (current) current[key] = value;
    }
    if (engine === 'mpd' && !outputs.some(o => o.outputname === 'Playback Engines')) throw fail('MPD_UNAVAILABLE');
    for (const output of outputs) {
      const enable = engine === 'mpd' && output.outputname === 'Playback Engines';
      if (Number.isInteger(output.id) && output.id >= 0 && enable !== (output.outputenabled === '1')) await this.mpdRaw((enable ? 'enableoutput ' : 'disableoutput ') + output.id);
    }
  }
  async check(device, format) {
    pcmParts(device.pcm);
    if (!format || ![16,24,32].includes(format.bits) || !Number.isInteger(format.rate) || !Number.isInteger(format.channels)) throw fail('UNSUPPORTED_FORMAT');
    return this.helperCall(['check', device.pcm, String(format.rate), String(format.bits), String(format.channels)]);
  }
  async systemctl(action) {
    try { return await this.run('/usr/bin/sudo', ['-n', '/bin/systemctl', action, UNIT], { timeout: 45000, maxBuffer: 65536 }); }
    catch { throw fail('RENDERER_SERVICE_ERROR'); }
  }
  async startRenderer(device) {
    const {card, device: number} = pcmParts(device.pcm);
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const conf = '</usr/share/alsa/alsa.conf>\npcm.!default {\n type hw\n card "' + card + '"\n device ' + number + '\n}\nctl.!default { type hw card "' + card + '" }\n';
    fs.writeFileSync(path.join(this.stateDir, 'asound.conf'), conf, { mode: 0o600 });
    await this.systemctl('start');
    const deadline = Date.now() + 20000;
    do {
      try {
        const {stdout} = await this.run('/bin/systemctl', ['show', UNIT, '--property=MainPID', '--value'], { timeout: 3000 });
        const pid = Number(stdout.trim());
        if (!Number.isInteger(pid) || pid < 2) throw fail('RENDERER_UNAVAILABLE');
        this.endpoints = await this.helperCall(['discover', String(pid)]);
        return this.endpoints;
      } catch { await delay(250); }
    } while (Date.now() < deadline);
    throw fail('RENDERER_UNAVAILABLE');
  }
  async stopRenderer() { this.endpoints = null; await this.systemctl('stop'); }
  async requestConfig(value) {
    if (!this.endpoints?.apiUrl) throw fail('RENDERER_UNAVAILABLE');
    const url = new URL(value === undefined ? '?GetConfig' : 'SetConfig', this.endpoints.apiUrl);
    const payload = value === undefined ? null : Buffer.from(JSON.stringify(value));
    return new Promise((resolve, reject) => {
      const request = http.request(url, { method: payload ? 'POST' : 'GET', headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) response.destroy(); else chunks.push(chunk); });
        response.on('error', () => reject(fail('RENDERER_UNAVAILABLE')));
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(fail('RENDERER_UNAVAILABLE'));
          const raw = Buffer.concat(chunks).toString();
          if (payload) return /Settings saved!/i.test(raw) && !/not saved/i.test(raw) ? resolve(true) : reject(fail('PROFILE_SAVE_FAILED'));
          try { resolve(JSON.parse(raw)); } catch { reject(fail('PROFILE_SAVE_FAILED')); }
        });
      });
      const timer = setTimeout(() => request.destroy(), 10000);
      request.on('close', () => clearTimeout(timer)); request.on('error', () => reject(fail('RENDERER_UNAVAILABLE')));
      request.end(payload);
    });
  }
  async probe(url) {
    try {
      const {stdout} = await this.run('/usr/bin/ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,channels', '-of', 'json', url], { timeout: 20000, maxBuffer: 65536 });
      const stream = JSON.parse(stdout).streams?.[0];
      let bits = Number(stream?.bits_per_raw_sample || stream?.bits_per_sample);
      if (!bits && /^(mp3|aac|opus|vorbis)$/.test(stream?.codec_name || '')) bits = 32;
      const rate = Number(stream?.sample_rate), channels = Number(stream?.channels);
      if (!stream || ![16,24,32].includes(bits) || /dsd/i.test(stream.codec_name || '') || !rate || !channels) throw fail('UNSUPPORTED_FORMAT');
      return { bits, rate, channels };
    } catch (e) { throw e.code === 'UNSUPPORTED_FORMAT' ? e : fail('UNSUPPORTED_FORMAT'); }
  }
}
module.exports = Runtime;
module.exports.writeJson = writeJson;
module.exports.fail = fail;
module.exports.pcmParts = pcmParts;
