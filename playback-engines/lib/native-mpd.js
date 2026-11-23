'use strict';

const {fail} = require('./runtime');
const {mpdArgument} = require('./transport');

function libraryPath(uri) {
  const relative = uri.replace(/^music-library\//, '').replace(/^\/?mnt\//, '');
  if (!/^(USB|NAS|INTERNAL)\//.test(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fail('LOCAL_FILE_UNAVAILABLE');
  }
  mpdArgument(relative);
  return relative;
}

async function localTrack(uri, runtime, localStream, preflight) {
  if (typeof uri !== 'string') throw fail('LOCAL_FILE_UNAVAILABLE');
  const legacy = /^cue:\/\/(.+\.cue)@(\d+)$/i.exec(uri);
  const virtual = /^(.*\.cue)\/track(\d+)$/i.exec(uri);
  const cue = legacy || virtual;
  const path = libraryPath(cue ? cue[1] : uri);
  let source = path;
  let index;
  if (cue) {
    index = Number(cue[2]) - (legacy ? 0 : 1);
    if (!Number.isSafeInteger(index) || index < 0 || index >= Number.MAX_SAFE_INTEGER) {
      throw fail('LOCAL_FILE_UNAVAILABLE');
    }
    const entries = await runtime.mpdRaw('listplaylistinfo ' + mpdArgument(path));
    source = entries.filter(line => line.startsWith('file: '))[index]?.slice(6);
    if (!source) throw fail('LOCAL_FILE_UNAVAILABLE');
    source = libraryPath(source);
  }
  if (!preflight) return {uri: path, index};
  const ticket = await localStream.resolveFile(encodeURIComponent(source));
  const {handle} = await localStream.openFile(ticket);
  await handle.close();
  return {uri: path, index, source: ticket.file};
}

module.exports = {localTrack};
