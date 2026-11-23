'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {promisify} = require('node:util');
const {execFile} = require('node:child_process');
const {fail, directAlsaConfig} = require('./runtime');

const UNIT = 'volumio-playback-aplayer.service';
const PROXY = 'volumio-playback-aplayer-proxy';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CONFIG_KEYS = ('covers gapless_mode preload_mode di_mode pframes bframes pmks bmks mode_16bit mode_24bit ' +
  'dop_mode pcm_freq dsd_limit dsd_pcm dsd_vol dsd_area sacd_full dvda_area dvda_nomix pcm_mult volume_enabled ' +
  'auto_mode cue_mode tags_mode lock_memory priority nice affinity_mode multi_mode swap_mode phase_mode res_bf44 ' +
  'res44 res48 res88 res96 res176 res192 res352 res384 soxr_phase soxr_filter soxr_quality radio_pict radio_proxy ' +
  'radio_proxy2 radio_ua radio_user std_buffer si_time mmap enable_dsd filter output rate level multithread root_folder ' +
  'use_conv conv_filter conv_db hw_index hw_volume att win1251 num_pics api_flag api_add radio_auto a_color t_color ' +
  'i_color ai_color ti_color yi_color ar_color ch_scr ch_tcp ip_scr pt_scr').split(' ');

class AplayerRuntime {
  constructor({stateDir, run = promisify(execFile), socketPath = '/run/volumio-playback-aplayer/api.sock'}) {
    this.slot = path.join(stateDir, 'aplayer-slot');
    Object.assign(this, {stateDir, run, socketPath});
    this.pid = null;
    this.requested = false;
    this.stopping = null;
  }

  async available() {
    try {
      await fs.access(path.join(this.stateDir, 'aplayer', 'aplayer'), fs.constants.X_OK);
    } catch {
      throw fail('APLAYER_NOT_INSTALLED');
    }
  }

  async systemctl(...args) {
    try {
      return await this.run('/usr/bin/sudo', ['-n', '/bin/systemctl', ...args], {timeout: 30000, maxBuffer: 65536});
    } catch {
      throw fail('APLAYER_SERVICE_ERROR');
    }
  }

  async readPid() {
    try {
      const {stdout} = await this.run('/bin/systemctl', ['show', UNIT, '--property=MainPID', '--value'], {timeout: 3000});
      const pid = Number(stdout.trim());
      if (!Number.isSafeInteger(pid) || pid < 2) throw fail('APLAYER_UNAVAILABLE');
      const executable = await fs.realpath(path.join(this.stateDir, 'aplayer', 'aplayer'));
      if (await fs.readlink('/proc/' + pid + '/exe') !== executable) throw fail('APLAYER_UNAVAILABLE');
      return pid;
    } catch {
      throw fail('APLAYER_UNAVAILABLE');
    }
  }

  async start(device, valid) {
    if (this.stopping) await this.stopping;
    await this.available();
    if (!valid()) return false;
    await fs.writeFile(path.join(this.stateDir, 'aplayer-asound.conf'), directAlsaConfig(device.pcm), {mode: 0o600});
    if (!valid()) return false;
    this.requested = true;
    await this.systemctl('start', PROXY + '.socket');
    const deadline = Date.now() + 5000;
    while (valid() && Date.now() < deadline) {
      try {
        const pid = await this.readPid();
        await this.request('State');
        this.pid = pid;
        return true;
      } catch {
        await delay(100);
      }
    }
    if (!valid()) return false;
    throw fail('APLAYER_UNAVAILABLE');
  }

  async recover() {
    try {
      const {stdout} = await this.run('/bin/systemctl', ['show', UNIT, '--property=ActiveState', '--value'], {timeout: 3000});
      this.requested = ['active', 'activating', 'deactivating', 'reloading'].includes(stdout.trim());
    } catch {}
    if (this.requested) await this.stop();
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (!this.requested) return Promise.resolve();
    this.stopping = (async () => {
      await this.systemctl('stop', UNIT, PROXY + '.socket', PROXY + '.service');
      this.pid = null;
      this.requested = false;
      await this.clearSlot();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async clearSlot() {
    const slot = await fs.lstat(this.slot).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!slot) return;
    if (!slot.isDirectory()) throw fail('LOCAL_FILE_UNAVAILABLE');
    const entries = await fs.readdir(this.slot, {withFileTypes: true}).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    await Promise.all(entries.filter(entry => entry.isSymbolicLink() && /^track-[a-f0-9]{24}\.(wav|flac|dsf|dff)$/.test(entry.name))
      .map(entry => fs.unlink(path.join(this.slot, entry.name))));
  }

  request(command, parameters, config) {
    const payload = config === undefined ? null : Buffer.from(JSON.stringify(config));
    const args = new URLSearchParams(parameters).toString();
    const requestPath = payload ? '/SetConfig' : '/?' + command + (args ? '&' + args : '');
    return new Promise((resolve, reject) => {
      const unavailable = () => reject(fail('APLAYER_UNAVAILABLE'));
      const request = http.request({
        socketPath: this.socketPath, path: requestPath, method: payload ? 'POST' : 'GET', agent: false,
        headers: payload ? {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length} : {}
      }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 1024 * 1024) response.destroy(fail('APLAYER_UNAVAILABLE'));
          else chunks.push(chunk);
        });
        response.on('error', unavailable);
        response.on('end', () => {
          if (response.statusCode !== 200) return unavailable();
          const raw = Buffer.concat(chunks).toString();
          if (payload) {
            if (!/settings saved!/i.test(raw) || /not saved/i.test(raw)) return reject(fail('PROFILE_SAVE_FAILED'));
            return resolve();
          }
          try { return resolve(JSON.parse(raw)); } catch { return unavailable(); }
        });
      });
      const timer = setTimeout(() => request.destroy(fail('APLAYER_UNAVAILABLE')), 2000);
      request.on('close', () => clearTimeout(timer));
      request.on('error', unavailable);
      request.end(payload);
    });
  }

  async configure(patch, valid) {
    const previous = await this.request('GetConfig');
    if (!valid()) return false;
    const payload = {};
    for (const key of CONFIG_KEYS) {
      if (Object.hasOwn(previous, key)) payload[key] = previous[key];
      if (Object.hasOwn(patch, key)) payload[key] = patch[key];
    }
    await this.request('SetConfig', undefined, payload);
    if (!valid()) return false;
    const actual = await this.request('GetConfig');
    if (!valid()) return false;
    if (Object.entries(patch).some(([key, value]) => actual[key] !== value)) throw fail('PROFILE_SAVE_FAILED');
    return true;
  }

  async setVolume(volume) {
    await this.request('SetVolume', {volume});
    if ((await this.request('State'))?.Volume !== volume) throw fail('VOLUME_UNAVAILABLE');
  }
}

module.exports = AplayerRuntime;
