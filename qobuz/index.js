'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const Q = require('kew');
const ApiClient = require('./lib/api-client');
const Browse = require('./lib/browse');
const Playback = require('./lib/playback');
function kew(p) { const d = Q.defer(); Promise.resolve(p).then(v => d.resolve(v), e => d.reject(e)); return d.promise; }

class ControllerQobuz {
  constructor(context, dependencies = {}) {
    this.context = context; this.router = context.coreCommand; this.logger = context.logger;
    this.api = dependencies.api; this.started = false; this.generation = 0; this.quality = '27';
    this.service = dependencies.service || {
      start: () => execFile('/usr/bin/sudo', ['-n', '/bin/systemctl', 'start', 'volumio-qobuz-custom.service']),
      stop: () => execFile('/usr/bin/sudo', ['-n', '/bin/systemctl', 'stop', 'volumio-qobuz-custom.service'])
    };
  }
  t(key) {
    const lang = this.router.sharedVars?.get('language_code')?.startsWith('ru') ? 'ru' : 'en';
    return require(`./i18n/strings_${lang}.json`)[key] || require('./i18n/strings_en.json')[key] || this.t('SERVICE_UNAVAILABLE');
  }
  statePath(name) { return this.router.pluginManager.getConfigurationFile(this.context, name); }
  client() {
    if (!this.api) this.api = new ApiClient({ key: fs.readFileSync(this.statePath('api-key'), 'utf8').trim() });
    return this.api;
  }
  notify(error) { this.router.pushToastMessage('error', 'Qobuz', this.t(error?.code || error?.message || 'SERVICE_UNAVAILABLE')); }
  onVolumioStart() { return Q.resolve(); }
  getConfigurationFiles() { return ['config.json']; }
  onStart() {
    if (!this.startPromise) this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return kew(this.startPromise);
  }
  async start() {
    if (this.started) return;
    const generation = ++this.generation;
    try { const saved = JSON.parse(fs.readFileSync(this.statePath('quality.json'), 'utf8')); if (['6', '27'].includes(saved.quality)) this.quality = saved.quality; } catch {}
    await this.service.start();
    try {
      let healthy = false;
      for (let i = 0; i < 40; i++) {
        if (generation !== this.generation) { await this.service.stop(); return; }
        try { const h = await this.client().request('GET', '/health'); if (h.ready && h.api_version === 1) { healthy = true; break; } } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      if (generation !== this.generation) { await this.service.stop(); return; }
      if (!healthy) throw new Error('SERVICE_UNAVAILABLE');
      this.browse = new Browse(this.client(), key => this.t(key));
      this.playback = new Playback(this.client(), this.router.pluginManager.getPlugin('music_service', 'mpd'), this.router.stateMachine,
        error => { this.notify(error); Promise.resolve(this.router.stateMachine.stop?.()).catch(() => {}); }, () => this.quality);
      this.playback.onQuality = info => this.router.broadcastMessage('pushQobuzCustomQuality', info);
      this.started = true;
      this.router.volumioAddToBrowseSources({ name: 'Qobuz Custom', uri: 'qobuz_custom', plugin_type: 'music_service', plugin_name: 'qobuz_custom', icon: 'fa-music' });
    } catch (e) { await this.service.stop(); throw e; }
  }
  onStop() { return kew(this.shutdown()); }
  async shutdown() {
    this.generation++; this.started = false; clearTimeout(this.timer);
    this.router.volumioRemoveToBrowseSources('Qobuz Custom');
    if (this.playback?.current()) await this.playback.stop(); else this.playback?.cancel();
    this.browse = null; this.playback = null; await this.service.stop();
  }
  handleBrowseUri(uri) { return kew(this.browse ? this.browse.browse(uri).catch(e => { this.notify(e); throw e; }) : Promise.reject(new Error('SERVICE_UNAVAILABLE'))); }
  search(query) { return kew(this.browse ? this.browse.search(query).catch(e => { this.notify(e); return []; }) : []); }
  explodeUri(uri) { return kew(this.browse ? this.browse.explode(uri) : Promise.reject(new Error('SERVICE_UNAVAILABLE'))); }
  clearAddPlayTrack(track) { return kew(this.playback?.clearAddPlayTrack(track)); }
  pause() { return kew(this.playback?.pause()); }
  resume() { return kew(this.playback?.resume()); }
  stop() { return kew(this.playback?.stop()); }
  seek(position) { return kew(this.playback?.seek(position)); }
  previous() { return kew(this.playback?.previous()); }
  getPlaybackQuality() { this.router.broadcastMessage('pushQobuzCustomQuality', this.playback?.current() ? this.playback.lastQuality || {} : {}); return Q.resolve(); }
  getUIConfig() { return kew(this.ui()); }
  async ui() {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'UIConfig.json'), 'utf8'));
    const account = config.sections[0];
    account.label = this.t('account');
    try { account.description = this.t((await this.client().request('GET', '/v1/account')).authenticated ? 'signedIn' : 'signedOut'); } catch { account.description = this.t('SERVICE_UNAVAILABLE'); }
    for (const button of account.content) button.label = this.t(button.id);
    const link = account.content.find(x => x.id === 'verification');
    if (this.loginUrl) { link.hidden = false; link.onClick.url = this.loginUrl; }
    const audio = config.sections[1]; audio.label = this.t('audio'); audio.saveButton.label = this.t('save');
    audio.content[0].label = this.t('quality');
    audio.content[0].options = ['27', '6'].map(value => ({ value, label: this.t(value === '27' ? 'maximum' : 'cd') }));
    audio.content[0].value = audio.content[0].options.find(x => x.value === this.quality);
    return config;
  }
  async refresh() { const ui = await this.ui(); this.router.broadcastMessage('pushUiConfig', ui); return ui; }
  refreshSettings() { return kew(this.refresh()); }
  startLogin() {
    return kew((async () => {
      try {
        const interfaces = os.networkInterfaces();
        const addresses = [...(interfaces.eth0 || []), ...(interfaces.wlan0 || []), ...Object.values(interfaces).flat()];
        const host = addresses.find(x => x.family === 'IPv4' && !x.internal)?.address;
        if (!host) throw new Error('SERVICE_UNAVAILABLE');
        this.loginUrl = (await this.client().request('POST', '/v1/auth/start', { host })).url;
      } catch (e) { this.notify(e); }
      return this.refresh();
    })());
  }
  logout() {
    return kew((async () => {
      if (this.playback?.current()) await this.playback.stop();
      await this.client().request('POST', '/v1/auth/logout', {}); this.loginUrl = null;
      return this.refresh();
    })());
  }
  saveQuality(data) {
    return kew((async () => {
      const quality = String(typeof data.quality === 'object' ? data.quality?.value : data.quality);
      if (!['6', '27'].includes(quality)) throw new Error('BAD_REQUEST');
      fs.writeFileSync(this.statePath('quality.json'), JSON.stringify({ quality }), { mode: 0o600 });
      this.quality = quality; return this.refresh();
    })());
  }
}
module.exports = ControllerQobuz;
