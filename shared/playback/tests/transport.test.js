'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { XMLParser } = require('fast-xml-parser');
const { SoapClient, AlbumPlayerTransport, createTransport, createTransportFromFile } = require('..');

async function renderer(t) {
  const state = { status: 'STOPPED', position: '0:00:00.000', duration: '0:04:07.000', actions: [], fault: false, hanging: false };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const action = req.headers.soapaction?.match(/#(\w+)/)?.[1];
    const parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(body);
    state.actions.push({ action, args: parsed.Envelope.Body[action] });
    if (state.hanging) return;
    let result = '';
    if (action === 'GetTransportInfo') result = `<CurrentTransportState>${state.status}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>`;
    if (action === 'GetPositionInfo') result = `<RelTime>${state.position}</RelTime><TrackDuration>${state.duration}</TrackDuration>`;
    if (action === 'Play') state.status = 'PLAYING';
    if (action === 'Pause') state.status = 'PAUSED_PLAYBACK';
    if (action === 'Stop') state.status = 'STOPPED';
    if (action === 'Play' && state.delayPlay) await state.delayPlay;
    if (action === 'Stop' && state.delayStop) await state.delayStop;
    res.end(state.fault
      ? '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>701</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>'
      : `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${result}</u:${action}Response></s:Body></s:Envelope>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new SoapClient(`http://127.0.0.1:${server.address().port}/control.xml`, { timeoutMs: 150 });
  return { state, client };
}
const track = { uri: 'qobuz_custom/track/42', name: 'A & B <live>', artist: 'Исполнитель', album: 'Album', duration: 247, trackType: 'flac' };
function transport(client, extra = {}) {
  const events = [], errors = [], mpdCommands = [];
  const sm = { setConsumeUpdateService: async () => {}, syncState: (s, source) => events.push({ ...s, source }) };
  const engine = new AlbumPlayerTransport({ client, mpd: { stop: async () => mpdCommands.push('stop') }, sm, service: 'qobuz_custom', onError: e => errors.push(e), pollMs: 60000, ...extra });
  return { engine, events, errors, mpdCommands };
}
test('selected renderer receives escaped track metadata and URL; MPD is stopped first', async t => {
  const { client, state } = await renderer(t); const { engine, mpdCommands } = transport(client); t.after(() => engine.close());
  await engine.play('http://127.0.0.1:17901/stream/test?x=1&y=2', track, () => true);
  const request = state.actions.find(x => x.action === 'SetAVTransportURI');
  assert.equal(request.args.CurrentURI, 'http://127.0.0.1:17901/stream/test?x=1&y=2');
  const didl = new XMLParser({ removeNSPrefix: true }).parse(request.args.CurrentURIMetaData);
  assert.equal(didl['DIDL-Lite'].item.title, 'A & B <live>');
  assert.equal(didl['DIDL-Lite'].item.creator, 'Исполнитель');
  assert.equal(mpdCommands.length, 1);
  assert.deepEqual(state.actions.map(x => x.action), ['Stop', 'SetAVTransportURI', 'Play']);
});
test('HTTP 200 SOAP faults reject and stalled requests time out', async t => {
  const { client, state } = await renderer(t);
  state.fault = true; await assert.rejects(client.call('Play', { InstanceID: 0, Speed: 1 }), e => e.code === 'ENGINE_ERROR' && e.soapCode === '701');
  state.fault = false; state.hanging = true;
  await assert.rejects(client.call('GetPositionInfo', { InstanceID: 0 }), e => e.code === 'ENGINE_UNAVAILABLE');
});
test('seek converts milliseconds without truncating fractional seconds', async t => {
  const { client, state } = await renderer(t); const { engine } = transport(client); t.after(() => engine.close());
  await engine.play('http://127.0.0.1/file.flac', track, () => true); await engine.seek(10500);
  assert.equal(state.actions.at(-1).args.Target, '00:00:10.500');
  await assert.rejects(engine.seek(-1));
});
test('startup STOPPED does not advance; natural end is emitted once with stable queue URI', async t => {
  const { client, state } = await renderer(t); const { engine, events } = transport(client); t.after(() => engine.close());
  await engine.play('http://127.0.0.1/file.flac', track, () => true);
  state.status = 'STOPPED'; await engine.poll(); assert.equal(events.length, 0);
  state.status = 'PLAYING'; state.position = '0:04:06.000'; await engine.poll();
  state.status = 'STOPPED'; state.position = '0:00:00.000'; await engine.poll(); await engine.poll();
  assert.deepEqual(events.map(x => x.status), ['play', 'stop']);
  assert.equal(events[0].uri, 'qobuz_custom/track/42'); assert.equal(events[0].seek, 246000);
  assert.equal(events[0].source, 'qobuz_custom');
});
test('early renderer failure reports error rather than advancing the queue', async t => {
  const { client, state } = await renderer(t); const { engine, events, errors } = transport(client); t.after(() => engine.close());
  await engine.play('http://127.0.0.1/file.flac', track, () => true); await engine.poll();
  state.status = 'STOPPED'; await engine.poll();
  assert.equal(events.filter(x => x.status === 'stop').length, 0); assert.equal(errors.length, 1);
});
test('unknown renderer duration keeps the duration supplied for a DSF file', async t => {
  const { client, state } = await renderer(t); const { engine, events } = transport(client); t.after(() => engine.close());
  await engine.play('http://127.0.0.1/file.dsf', { ...track, duration: 10.5, trackType: 'dsf' }, () => true);
  state.duration = '1193046:28:15.000';
  state.position = '0:00:10.000';
  await engine.poll();
  state.status = 'STOPPED';
  await engine.poll();
  assert.deepEqual(events.map(event => [event.status, event.duration]), [['play', 10.5], ['stop', 10.5]]);
});
test('stale start cannot open renderer after MPD release; stale polls cannot update queue', async t => {
  const { client, state } = await renderer(t); let owned = true;
  const { engine, events } = transport(client, { mpd: { stop: async () => { owned = false; } } }); t.after(() => engine.close());
  await engine.play('http://127.0.0.1/file.flac', track, () => owned); assert.equal(state.actions.length, 0);
  owned = true; engine.mpd = { stop: async () => {} };
  await engine.play('http://127.0.0.1/file.flac', track, () => owned);
  owned = false; await engine.poll(); assert.equal(events.length, 0);
});
test('intentional stop cancels polling without publishing a natural end', async t => {
  const { client } = await renderer(t); const { engine, events } = transport(client); t.after(() => engine.close());
  await engine.play('http://127.0.0.1/file.flac', track, () => true); await engine.poll();
  await engine.stop(); await engine.poll(); assert.deepEqual(events.map(x => x.status), ['play']);
});
test('unknown engine selection fails; absent config keeps MPD', () => {
  for (const engine of ['typo', '', false, 0, null]) assert.throws(() => createTransport({ config: { engine } }));
  assert.equal(createTransport({}).kind, 'mpd');
});

test('missing optional configuration keeps MPD; corrupt explicit configuration rejects', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-config-')); t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'transport.json');
  assert.equal(createTransportFromFile(file).kind, 'mpd');
  fs.writeFileSync(file, '{broken'); assert.throws(() => createTransportFromFile(file), e => e.code === 'BAD_ENGINE_CONFIG');
  fs.writeFileSync(file, 'null'); assert.throws(() => createTransportFromFile(file), e => e.code === 'BAD_ENGINE_CONFIG');
  fs.writeFileSync(file, JSON.stringify({ engine: 'album_player', controlUrl: 'http://127.0.0.1:1234/control.xml' }));
  assert.equal(createTransportFromFile(file).kind, 'album_player');
});

test('pause during an accepted but unacknowledged Play cannot leave untracked audio running', async t => {
  const Playback = require('../../../qobuz/lib/playback');
  const { client, state } = await renderer(t);
  let release; state.delayPlay = new Promise(resolve => { release = resolve; });
  const sm = { getTrack: () => track, setConsumeUpdateService: async () => {}, syncState: () => {} };
  const { engine } = transport(client, { sm }); t.after(() => engine.close());
  const playback = new Playback({ request: async () => ({ path: '/stream/test', codec: 'flac' }), streamUrl: path => 'http://127.0.0.1:17901' + path }, {}, sm, () => {}, undefined, engine);
  const starting = playback.clearAddPlayTrack(track);
  for (let i = 0; i < 100 && state.status !== 'PLAYING'; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(state.status, 'PLAYING');
  const pausing = playback.pause(); release();
  await Promise.all([starting, pausing]);
  assert.equal(state.status, 'STOPPED'); assert.equal(engine.session, null);
});

test('renderer stuck in TRANSITIONING fails within the startup deadline', async t => {
  const { client, state } = await renderer(t); const { engine, errors } = transport(client, { startupTimeoutMs: 10 }); t.after(() => engine.close());
  await engine.play('http://127.0.0.1/file.flac', track, () => true);
  state.status = 'TRANSITIONING';
  await new Promise(resolve => setTimeout(resolve, 20)); await engine.poll();
  assert.equal(errors[0]?.code, 'ENGINE_UNAVAILABLE'); assert.equal(engine.session, null);
});

test('slow native decoder shutdown may acknowledge Stop after five seconds', async t => {
  const { client, state } = await renderer(t);
  let release; state.delayStop = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(release, 5500); t.after(() => { clearTimeout(timer); release(); });
  const nativeClient = new SoapClient(client.url);
  await nativeClient.call('Stop', { InstanceID: 0 });
  assert.equal(state.status, 'STOPPED');
});

test('startup readiness deadline begins after Play acknowledgement', async t => {
  const { client, state } = await renderer(t); const { engine, errors } = transport(client, { startupTimeoutMs: 20 }); t.after(() => engine.close());
  state.delayPlay = new Promise(resolve => setTimeout(resolve, 50));
  await engine.play('http://127.0.0.1/file.flac', track, () => true);
  state.status = 'STOPPED'; await engine.poll();
  assert.equal(errors.length, 0); assert.ok(engine.session);
});

test('MPD end signal excludes decoder errors, Stop, and duplicate notifications', async () => {
  const { MpdTransport } = require('..');
  const ended = [], sm = { currentStatus: 'play', setConsumeUpdateService: async () => {} };
  const mpd = { parseState: raw => ({ status: raw.state, seek: raw.seek }), sendMpdCommand: async () => ({}), stop: async () => {} };
  const original = mpd.parseState;
  const transport = new MpdTransport({ mpd, sm, onTrackEnd: track => ended.push(track.uri) });
  const track = { uri: 'wave/1', duration: 10 };
  await transport.play('http://127.0.0.1/one', track, () => true);
  mpd.parseState({ state: 'play', seek: 9500 }); mpd.parseState({ state: 'stop' }); mpd.parseState({ state: 'stop' });
  assert.deepEqual(ended, [track.uri]);
  await transport.play('http://127.0.0.1/one', track, () => true);
  mpd.parseState({ state: 'play', seek: 9500 }); mpd.parseState({ state: 'stop', error: 'decode failed' });
  await transport.play('http://127.0.0.1/one', track, () => true);
  mpd.parseState({ state: 'play', seek: 9500 }); await transport.stop(); mpd.parseState({ state: 'stop' });
  assert.equal(ended.length, 1); transport.close(); assert.equal(mpd.parseState, original);
});

test('MPD activation keeps the logical source during pause and seek', async () => {
  const { MpdTransport } = require('..');
  const sm = { consumeState: {}, setConsumeUpdateService: async source => { sm.consumeState.service = source; } };
  const transport = new MpdTransport({ sm, service: 'yandex_music' });
  await transport.activate(); assert.equal(sm.consumeState.service, 'yandex_music');
});

test('MPD EOF uses decoder duration and elapsed playback between status events', async () => {
  const { MpdTransport } = require('..'); const ended = [], errors = [];
  const sm = { currentStatus: 'play', setConsumeUpdateService: async () => {} };
  const mpd = { parseState: raw => raw, sendMpdCommand: async () => ({}) };
  const transport = new MpdTransport({ mpd, sm, onTrackEnd: track => ended.push(track.uri), onError: e => errors.push(e) });
  await transport.play('http://localhost/track', { uri: 'track', duration: 30 }, () => true);
  mpd.parseState({ status: 'play', seek: 16000, duration: 20 });
  transport.session.at -= 4000;
  mpd.parseState({ status: 'stop' }); assert.deepEqual(ended, ['track']); assert.deepEqual(errors, []);
  transport.close();
});

test('activating a new engine cannot expose the previous consume playback status', async () => {
  const { MpdTransport, AlbumPlayerTransport } = require('..');
  for (const Type of [MpdTransport, AlbumPlayerTransport]) {
    const sm = { currentStatus: 'stop', consumeState: { status: 'play' }, setConsumeUpdateService: async () => {} };
    const transport = new Type({ sm, service: 'yandex_music' });
    await transport.activate(); assert.equal(sm.consumeState.status, 'stop');
  }
});

test('closing an old MPD source cannot break the new source parser', async () => {
  const { MpdTransport } = require('..'), ended = [];
  const sm = { currentStatus: 'play', setConsumeUpdateService: async () => {} };
  const mpd = { parseState: raw => raw, sendMpdCommand: async () => ({}) };
  const original = mpd.parseState;
  const first = new MpdTransport({ sm, mpd });
  const second = new MpdTransport({ sm, mpd, onTrackEnd: track => ended.push(track.uri) });
  await first.play('http://localhost/one', { uri: 'one', duration: 10 }, () => false);
  await second.play('http://localhost/two', { uri: 'two', duration: 10 }, () => true);
  first.close();
  mpd.parseState({ status: 'play', seek: 9500, duration: 10 }); mpd.parseState({ status: 'stop' });
  assert.deepEqual(ended, ['two']); second.close(); assert.equal(mpd.parseState, original);
});
