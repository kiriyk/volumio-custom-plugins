'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const Q = require('kew');
const ApiClient = require('./lib/api-client');
const Browse = require('./lib/browse');
const Playback = require('./lib/playback');
const { LocalFileInfo } = require('./lib/local-file-info');

function kew(promise) {
  const deferred = Q.defer();
  Promise.resolve(promise).then(value => deferred.resolve(value), error => deferred.reject(error));
  return deferred.promise;
}

class ControllerYandexMusic {
  constructor(context, dependencies = {}) {
    this.context = context; this.router = context.coreCommand; this.logger = context.logger;
    this.api = dependencies.api;
    this.service = dependencies.service || {
      start: () => execFile('/usr/bin/sudo', ['-n', '/bin/systemctl', 'start', 'volumio-yandex.service']),
      stop: () => execFile('/usr/bin/sudo', ['-n', '/bin/systemctl', 'stop', 'volumio-yandex.service'])
    };
    this.started = false; this.loginGeneration = 0; this.login = null; this.timer = null;
    this.lifecycleGeneration = 0; this.shutdownGeneration = -1; this.startPromise = null;
    this.quality = 'auto';
    this.localFiles = new LocalFileInfo();
  }
  qualityPath() {
    const get = this.router.pluginManager.getConfigurationFile;
    return typeof get === 'function' ? path.join(path.dirname(get.call(this.router.pluginManager, this.context, 'api-key')), 'quality.json') : null;
  }
  loadQuality() {
    try {
      const quality = JSON.parse(fs.readFileSync(this.qualityPath(), 'utf8')).quality;
      if (['auto', 'lossless', 'mp3'].includes(quality)) this.quality = quality;
    } catch { /* missing settings use the default */ }
  }
  t(key) {
    const lang = this.router.sharedVars?.get('language_code')?.startsWith('ru') ? 'ru' : 'en';
    return require(`./i18n/strings_${lang}.json`)[key] || require('./i18n/strings_en.json')[key] || key;
  }
  client() {
    if (!this.api) {
      const keyPath = this.router.pluginManager.getConfigurationFile(this.context, 'api-key');
      this.api = new ApiClient({ key: fs.readFileSync(keyPath, 'utf8').trim() });
    }
    return this.api;
  }
  notify(error, type = 'error') {
    const code = error?.code || error?.message || error;
    const safe = this.t(code);
    this.router.pushToastMessage(type, 'Яндекс Музыка', safe === code ? this.t('SERVICE_UNAVAILABLE') : safe);
    if (type === 'error') this.logger?.error('[yandex_music] request failed');
  }
  onVolumioStart() { return Q.resolve(); }
  getConfigurationFiles() { return ['config.json']; }
  onStart() {
    if (!this.startPromise) this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return kew(this.startPromise);
  }
  async start() {
    if (this.started) return;
    this.loadQuality();
    const generation = ++this.lifecycleGeneration;
    const cancelled = async () => {
      if (generation === this.lifecycleGeneration) return false;
      if (this.shutdownGeneration === this.lifecycleGeneration) await this.service.stop();
      return true;
    };
    await this.service.start();
    try {
      if (await cancelled()) return;
      let healthy = false;
      for (let i = 0; i < 40; i++) {
        try {
          const health = await this.client().request('GET', '/health');
          if (await cancelled()) return;
          if (health.ready && health.api_version === 1) { healthy = true; break; }
        } catch { /* systemd may still be starting Python */ }
        await new Promise(resolve => setTimeout(resolve, 500));
        if (await cancelled()) return;
      }
      if (!healthy) throw new Error('SERVICE_UNAVAILABLE');
      const api = this.client();
      this.browse = new Browse(api, key => this.t(key), code => this.notify(code, 'info'));
      this.playback = new Playback(api, this.router.pluginManager.getPlugin('music_service', 'mpd'),
        this.router.stateMachine, error => {
          this.notify(error);
          Promise.resolve(this.router.stateMachine.stop?.()).catch(() => {});
        }, () => this.quality);
      this.playback.onQuality = info => this.router.broadcastMessage('pushYandexQuality', info);
      this.playback.probeQuality = async url => {
        const { stdout } = await execFile('/usr/bin/ffprobe', ['-v', 'error', '-select_streams', 'a:0',
          '-show_entries', 'stream=sample_rate,bits_per_raw_sample', '-of', 'json', url],
          { timeout: 15000, maxBuffer: 16384 });
        const stream = JSON.parse(stdout).streams?.[0] || {};
        const sampleRate = Number(stream.sample_rate), bitDepth = Number(stream.bits_per_raw_sample);
        return { ...(Number.isFinite(sampleRate) && sampleRate > 0 ? { sampleRate } : {}),
          ...(Number.isFinite(bitDepth) && bitDepth > 0 ? { bitDepth } : {}) };
      };
      this.started = true;
      this.router.volumioAddToBrowseSources({ name: 'Яндекс Музыка', uri: 'yandex_music',
        plugin_type: 'music_service', plugin_name: 'yandex_music', icon: 'fa-music' });
    } catch (error) {
      if (generation === this.lifecycleGeneration) await this.service.stop();
      throw error;
    }
  }
  onStop() { return kew(this.shutdown()); }
  async shutdown() {
    this.shutdownGeneration = ++this.lifecycleGeneration;
    this.started = false; this.loginGeneration++; clearTimeout(this.timer);
    this.router.volumioRemoveToBrowseSources('Яндекс Музыка');
    if (this.playback) {
      if (this.playback.current()) await this.playback.stop();
      else this.playback.cancel();
    }
    this.browse = null; this.playback = null;
    await this.service.stop();
  }
  handleBrowseUri(uri) {
    return kew((async () => {
      if (!this.browse) throw new Error('SERVICE_UNAVAILABLE');
      try { return await this.browse.browse(uri); }
      catch (error) { this.notify(error); throw error; }
    })());
  }
  search(query) {
    return kew(this.browse ? this.browse.search(query).catch(error => { this.notify(error); return []; }) : []);
  }
  getPlaybackQuality() {
    const info = this.playback?.current() ? this.playback.lastQuality : null;
    this.router.broadcastMessage('pushYandexQuality', info || {});
    return Q.resolve();
  }
  getLocalFileInfo(data) {
    return kew((async () => {
      const uri = typeof data?.uri === 'string' ? data.uri : '';
      const info = await this.localFiles.get(uri);
      this.router.broadcastMessage('pushLocalFileInfo', info || { uri });
    })());
  }
  explodeUri(uri) { return kew(this.browse ? this.browse.explode(uri) : Promise.reject(new Error('SERVICE_UNAVAILABLE'))); }
  clearAddPlayTrack(track) { return kew(this.playback?.clearAddPlayTrack(track)); }
  pause() { return kew(this.playback?.pause()); }
  resume() { return kew(this.playback?.resume()); }
  stop() { return kew(this.playback?.stop()); }
  // Volumio invokes stop() on the music service, while lifecycle uses onStop().
  seek(position) { return kew(this.playback?.seek(position)); }
  previous() { return kew(this.playback?.previous()); }
  getUIConfig() { return kew(this.uiConfig()); }
  async uiConfig() {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'UIConfig.json'), 'utf8'));
    const account = config.sections[0];
    account.label = this.t('account');
    for (const item of account.content) item.label = this.t(item.id);
    try {
      const status = await this.client().request('GET', '/v1/account');
      account.description = status.authenticated ? `${this.t('signedIn')}: ${status.user.name}` : this.t('signedOut');
    } catch { account.description = this.t('SERVICE_UNAVAILABLE'); }
    if (this.login) {
      account.description += ` · ${this.t(this.login.status)} · ${this.t('code')}: ${this.login.user_code}`;
      const link = account.content.find(item => item.id === 'verification');
      link.hidden = false; link.onClick.url = this.login.verification_url;
    }
    config.sections[1].label = this.t('manual');
    config.sections[1].description = this.t('manualDescription');
    config.sections[1].saveButton.label = this.t('save');
    const audio = config.sections[2];
    audio.label = this.t('audio'); audio.saveButton.label = this.t('saveSettings');
    const setting = audio.content[0]; setting.label = this.t('quality');
    setting.options = ['auto', 'lossless', 'mp3'].map((value, i) => ({ value, label: this.t(['qualityAuto', 'qualityLossless', 'qualityMp3'][i]) }));
    setting.value = setting.options.find(option => option.value === this.quality);
    return config;
  }
  saveQuality(data) {
    return kew((async () => {
      const quality = typeof data.quality === 'object' ? data.quality?.value : data.quality;
      if (!['auto', 'lossless', 'mp3'].includes(quality)) throw new Error('BAD_REQUEST');
      const filename = this.qualityPath();
      if (!filename) throw new Error('SERVICE_UNAVAILABLE');
      fs.writeFileSync(filename, JSON.stringify({ quality }), { mode: 0o600 });
      this.quality = quality;
      return this.refreshUI();
    })());
  }
  refreshSettings() { return kew(this.refreshUI()); }
  async refreshUI() {
    const config = await this.uiConfig();
    this.router.broadcastMessage('pushUiConfig', config);
    return config;
  }
  startLogin() {
    return kew((async () => {
      try {
        const generation = ++this.loginGeneration;
        clearTimeout(this.timer);
        this.login = await this.client().request('POST', '/v1/auth/device', {});
        await this.refreshUI();
        this.pollLogin(generation);
      } catch (error) { this.notify(error); }
    })());
  }
  pollLogin(generation) {
    this.timer = setTimeout(async () => {
      if (!this.started || generation !== this.loginGeneration) return;
      try {
        const status = await this.client().request('GET', `/v1/auth/device/${encodeURIComponent(this.login.id)}`);
        if (!this.started || generation !== this.loginGeneration) return;
        this.login = status;
        await this.refreshUI();
        if (status.status === 'pending') this.pollLogin(generation);
        else if (status.status === 'success') this.notify('success', 'success');
      } catch (error) { this.notify(error); }
    }, 3000);
    this.timer.unref?.();
  }
  saveToken(data) {
    return kew((async () => {
      try {
        this.loginGeneration++; clearTimeout(this.timer);
        await this.client().request('POST', '/v1/auth/token', { token: data.token });
        this.login = null;
        this.notify('success', 'success');
      } catch (error) { this.notify(error); }
      return this.refreshUI();
    })());
  }
  logout() {
    return kew((async () => {
      try {
        this.loginGeneration++; clearTimeout(this.timer); this.login = null;
        if (this.playback?.current()) await this.playback.stop();
        await this.client().request('POST', '/v1/auth/logout', {});
      } catch (error) { this.notify(error); }
      return this.refreshUI();
    })());
  }
}
module.exports = ControllerYandexMusic;
