'use strict';
// Run on the Pi only; uses Volumio's installed Socket.IO client and native API.
const io = require('/volumio/node_modules/socket.io-client');
const socket = io.connect('http://127.0.0.1:3000', { reconnection: false });
const deadline = setTimeout(() => { console.error('Native API timed out'); socket.close(); process.exit(1); }, 45000);
const rpc = (event, data, response) => new Promise(resolve => {
  socket.once(response, resolve); socket.emit(event, data);
});
socket.once('connect', async () => {
  try {
    const action = process.argv[2] || 'read';
    const plugin = { category: 'music_service', plugin: 'yandex_music' };
    if (action === 'enable') {
      await rpc('pluginManager', { category: 'music_service', name: 'yandex_music', action: 'enable' }, 'pushInstalledPlugins');
    } else if (action === 'disable') {
      await rpc('pluginManager', { category: 'music_service', name: 'yandex_music', action: 'disable' }, 'pushInstalledPlugins');
    } else if (action === 'uninstall') {
      await rpc('unInstallPlugin', { category: 'music_service', name: 'yandex_music' }, 'pushUnInstallPlugin');
    }
    const sources = await rpc('getBrowseSources', {}, 'pushBrowseSources');
    const found = sources.find(source => source.plugin_name === 'yandex_music');
    const result = { sourcePresent: !!found, action };
    if (found) {
      const config = await rpc('getUiConfig', { page: 'music_service/yandex_music' }, 'pushUiConfig');
      result.sections = config.sections.map(section => section.label);
      result.tokenEmpty = config.sections.flatMap(section => section.content || [])
        .find(item => item.id === 'token').value === '';
      const library = await rpc('browseLibrary', { uri: 'yandex_music' }, 'pushBrowseLibrary');
      result.rootItems = library.navigation.lists[0].items.map(item => item.title);
    }
    console.log(JSON.stringify(result));
    clearTimeout(deadline); socket.close();
  } catch { console.error('Native smoke failed'); clearTimeout(deadline); socket.close(); process.exitCode = 1; }
});
