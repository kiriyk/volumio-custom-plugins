'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { LocalMusicLibrary, localPath, normalizedArt } = require('../plugin/artwork_one/local-music-library');
const { LocalMusicCache } = require('../plugin/artwork_one/local-music-cache');
const { MusicCatalog, editionHints, remote } = require('../plugin/artwork_one/music-catalog');
const { LocalMusicService, convertImage } = require('../plugin/artwork_one/local-music-service');

const DAY = 86_400_000;
const request = (fields, overrides) => ({ requestId: 'test-1', kind: 'album', uri: 'albums://Band/Record', locale: 'en', fields, ...overrides });
const artwork = (p) => '/albumart?path=' + encodeURIComponent(p) + '&icon=dot-circle-o&metadata=false';
const localEntity = { kind: 'album', key: 'record', artist: 'Band', title: 'Record', year: '2001', track: 'USB/Drive/Record/01.mp3', art: artwork('USB/Drive/Record') };
const jpeg = Buffer.from([255, 216, 255, 219, 1]);
const cleanup = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artwork-one-music-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('remote requests retry four times and respect Retry-After', async () => {
  let calls = 0;
  const delays = [];
  const reply = await remote('https://example.test', {
    fetcher: async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503, headers: { 'Retry-After': '3' } });
      if (calls === 2) throw new TypeError('fetch failed');
      if (calls <= 4) return new Response(null, { status: 429 });
      return new Response('complete');
    },
    wait: async delay => delays.push(delay)
  });
  assert.equal(reply.body.toString(), 'complete');
  assert.equal(calls, 5);
  assert(delays[0] >= 2900 && delays[0] <= 3000);
  assert.deepEqual(delays.slice(1), [2000, 4000, 8000]);

  const until = new Date(Date.now() + 60_000).toUTCString();
  await assert.rejects(remote('https://example.test', {
    fetcher: async () => new Response(null, { status: 503, headers: { 'Retry-After': until } }),
    wait: () => assert.fail('long server cooldown must be returned to the cache')
  }), { retryAfter: Date.parse(until) });

  await assert.rejects(remote('https://example.test', {
    fetcher: async () => new Response(null, { status: 403 }),
    wait: () => assert.fail('a permanent client error should not be retried')
  }), /403/);
});

test('track size and bitrate are cached by complete file identity and survive reopening', async t => {
  const dir = await cleanup(t);
  const tracks = ['First', 'Second'].map(album => 'INTERNAL/' + album + '/One.flac');
  for (const [i, track] of tracks.entries()) {
    await fs.mkdir(path.dirname(path.join(dir, track)), { recursive: true });
    await fs.writeFile(path.join(dir, track), Buffer.alloc(i + 10));
  }
  const cacheDir = path.join(dir, 'cache');
  const library = new LocalMusicLibrary({}, { mountRoot: dir, probe: async file => ({
    format: { bit_rate: file.includes('/First/') ? 100000 : 200000 }
  }) });
  const service = new LocalMusicService({}, cacheDir, { library });
  assert.deepEqual(await service.fileInfo('mnt/' + tracks[0]), { size: 10, bitrate: 100000 });
  assert.deepEqual(await service.fileInfo('mnt/' + tracks[1]), { size: 11, bitrate: 200000 });
  library.probe = async () => ({ format: { bit_rate: 300000 } });
  const reopened = new LocalMusicService({}, cacheDir, { library });
  assert.deepEqual(await reopened.fileInfo('music-library/' + tracks[0]), { size: 10, bitrate: 100000 });
  await fs.appendFile(path.join(dir, tracks[0]), 'changed');
  assert.deepEqual(await reopened.fileInfo('mnt/' + tracks[0]), { size: 17, bitrate: 300000 });
});

test('clearing the cache removes its files and drops writes from older lookups', async t => {
  const dir = await cleanup(t);
  const cache = new LocalMusicCache(dir);
  await cache.result('cover', () => 'jpeg');
  assert(await cache.usage() > 0);
  let finish;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const pending = cache.result('pending', () => new Promise(resolve => { finish = resolve; started(); }));
  await waiting;
  await fs.writeFile(path.join(dir, 'unrelated'), 'keep');
  await cache.clear();
  finish('old');
  await pending;
  assert.equal(await cache.usage(), 0);
  assert.deepEqual(await fs.readdir(dir), ['unrelated']);
  await cache.result('cover', () => 'x'.repeat(100));
  await cache.resize(1);
  assert.equal(await cache.usage(), 0);
});

test('Volumio CUE album and playing track share an identity when the displayed artist is blank', async () => {
  const track = 'USB/Drive/Record/Band.cue/track0001';
  const track2 = 'USB/Drive/Record/Band.cue/track0002';
  const info = { type: 'album', album: 'Record', artist: '', albumart: artwork('/mnt/USB/Drive/Record/Band.cue') };
  const sendCommand = (command, callback) => {
    const name = /^find file "(.+)"$/.exec(command)?.[1];
    assert.equal(name, track2);
    callback(null, 'file: ' + name + '\nAlbum: Record\nAlbumArtist: Band\n');
  };
  const mpd = {
    handleBrowseUri: (uri) => {
      assert.match(uri, /^(albums|artists):\/\/Band\/Record$/);
      return { navigation: { info, lists: [{ items: [
        { type: 'song', uri: 'music-library/' + track2, tracknumber: '02' },
        { type: 'song', uri: 'music-library/' + track, tracknumber: '01' }
      ] }] } };
    },
    mpdReady: Promise.resolve(),
    clientMpd: { sendCommand }
  };
  const library = new LocalMusicLibrary({ pluginManager: { getPlugin: () => mpd } });
  const card = await library.resolve(request(['cover']));
  const artistCard = await library.resolve(request(['cover'], { uri: 'artists://Band/Record' }));
  const playing = await library.resolve(request(['cover'], { uri: 'mnt/' + track2 }));
  assert.equal(card.key, playing.key);
  assert.equal(artistCard.key, playing.key);
  assert.equal(playing.track, track);
  assert.equal(playing.artist, 'Band');
  assert.equal(card.art, artwork('/mnt/USB/Drive/Record'));
  assert.equal(normalizedArt(artwork(track2)), artwork('USB/Drive/Record'));
  assert.equal(localPath('/mnt/USB/Drive/../wrong.mp3'), '');
  assert.equal(localPath('USB/Drive/file.mp3\nstatus'), '');
});

test('CUE track chooses the current FILE and rejects missing tracks and linked files outside the mount', async t => {
  const root = await cleanup(t);
  const mounted = path.join(root, 'drive');
  await fs.mkdir(mounted);
  await fs.mkdir(path.join(root, 'USB'));
  await fs.symlink(mounted, path.join(root, 'USB', 'External'));
  await fs.writeFile(path.join(mounted, 'One.flac'), '');
  await fs.writeFile(path.join(mounted, 'Two.flac'), '');
  const sheet = path.join(mounted, 'Album.cue');
  await fs.writeFile(sheet, [
    'FILE "One.flac" WAVE', '  TRACK 01 AUDIO', '  TRACK 02 AUDIO',
    'FILE "Two.flac" WAVE', '  TRACK 03 AUDIO', '  TRACK 04 AUDIO',
    'FILE "Outside.flac" WAVE', '  TRACK 05 AUDIO'
  ].join('\n'));
  await fs.writeFile(path.join(root, 'outside.flac'), '');
  await fs.symlink(path.join(root, 'outside.flac'), path.join(mounted, 'Outside.flac'));
  const library = new LocalMusicLibrary({}, { mountRoot: root });
  assert.equal(await library.audioFile('USB/External/Album.cue/track0002'), path.join(mounted, 'One.flac'));
  assert.equal(await library.audioFile('USB/External/Album.cue/track0004'), path.join(mounted, 'Two.flac'));
  assert.equal(await library.audioFile('USB/External/Album.cue/track0005'), undefined);
  assert.equal(await library.audioFile('USB/External/Album.cue/track0006'), null);
});

test('regular editions remain independent even when Volumio lists both under one album URI', async () => {
  const first = 'USB/Drive/Record original/01.mp3';
  const second = 'USB/Drive/Record import/01.mp3';
  const mpd = {
    handleBrowseUri: () => ({ navigation: {
      info: { type: 'album', album: 'Record', albumart: artwork('USB/Drive/Record original') },
      lists: [{ items: [first, second].map(uri => ({ type: 'song', uri: 'music-library/' + uri, tracknumber: '01' })) }]
    } }),
    clientMpd: { sendCommand: (_, done) => done(null, 'file: ' + second + '\nAlbum: Record\nAlbumArtist: Band\n') }
  };
  const library = new LocalMusicLibrary({ pluginManager: { getPlugin: () => mpd } });
  const original = await library.resolve(request(['cover']));
  const importEdition = await library.resolve(request(['cover'], { uri: second }));
  assert.notEqual(original.key, importEdition.key);
  assert.equal(importEdition.track, second);
  assert.equal(importEdition.art, '');
});

function group(id, title, type, artist = 'Arctic Monkeys') {
  return { id, title, 'primary-type': type, 'first-release-date': '2018-05-11', 'artist-credit': [
    { artist: { id: 'artist', name: artist } }
  ] };
}

test('only MusicBrainz uses the configured proxy and stopping closes it', async () => {
  const calls = [];
  let closed = false;
  const proxy = { async destroy() { closed = true; } };
  const catalog = new MusicCatalog({ musicBrainzProxy: proxy, fetcher: async (url, options) => {
    calls.push([url.hostname, options.dispatcher]);
    return new Response('{}');
  } });
  await catalog.mb('artist/', { query: 'artist:Band' });
  await catalog.image('release-group', 'group');
  await catalog.json('https://www.wikidata.org/w/api.php', host => host === 'www.wikidata.org');
  assert.deepEqual(calls, [
    ['musicbrainz.org', proxy], ['coverartarchive.org', undefined], ['www.wikidata.org', undefined]
  ]);
  catalog.stop();
  assert.equal(closed, true);
});

test('plus/ampersand album title collision with a single selects the full-length group for 11 local tracks', async () => {
  const catalog = new MusicCatalog();
  const queries = [];
  catalog.mb = async (_, { query }) => {
    queries.push(query);
    const rows = query.includes(' + ') ? [group('single', 'Tranquility Base Hotel + Casino', 'Single')]
      : [group('album', 'Tranquility Base Hotel & Casino', 'Album')];
    return { count: rows.length, 'release-groups': rows };
  };
  const match = await catalog.album({ artist: 'Arctic Monkeys', title: 'Tranquility Base Hotel + Casino', trackCount: 11 });
  assert.equal(match.groupId, 'album');
  assert.equal(queries.length, 2);
  assert.equal(queries[0].includes(' + '), true);
  assert.equal(queries[1].includes(' & '), true);
});

test('catalog number, repress year and country select a confirmed label without inheriting the original label', async () => {
  const catalog = new MusicCatalog();
  const entity = { artist: 'Alphaville', title: 'Forever Young (US edition)', year: '1984',
    track: 'USB/Drive/1984 - Forever Young (Repress 1989) (US, Atlantic, 7 80186-2)/01 - A Victory Of Love.flac' };
  assert.deepEqual(Object.fromEntries(Object.entries(editionHints(entity.title, {}, entity.track)).filter(([k]) => ['base','country','catalog','year'].includes(k))),
    { base: 'Forever Young', country: 'US', catalog: '7 80186-2', year: '1989' });
  const releaseGroup = group('forever', 'Forever Young', 'Album', 'Alphaville');
  const release = (id, date, country, label) => ({ id, date, country, title: 'Forever Young', 'release-group': releaseGroup,
    'artist-credit': releaseGroup['artist-credit'], 'label-info': [{ 'catalog-number': '7 80186-2', label: { name: label } }] });
  catalog.mb = async (endpoint, { query }) => {
    if (endpoint === 'release-group/') {
      const rows = query.includes('(US edition)') ? [] : [releaseGroup];
      return { count: rows.length, 'release-groups': rows };
    }
    assert.match(query, /catno:"7 80186-2"/);
    return { count: 2, releases: [release('old', '', 'US', 'Original label'), release('repress', '1989-10-23', 'US', 'Atlantic')] };
  };
  const found = await catalog.album(entity);
  assert.equal(found.releaseId, 'repress');
  assert.equal(found.year, '1989');
  assert.equal(found.label, 'Atlantic');
  const withoutCatalog = await catalog.album({ ...entity, track: undefined });
  assert.equal(withoutCatalog.groupId, 'forever');
  assert.equal(withoutCatalog.label, undefined);
});

test('a studio release-parent does not satisfy a live local title and an exact single can be found', async () => {
  const catalog = new MusicCatalog();
  catalog.mb = async (_, { query }) => ({
    count: 1,
    'release-groups': query.includes('One') ? [group('single', 'One', 'Single', 'Band')]
      : [group('studio', 'Record', 'Album', 'Band')]
  });
  assert.equal(await catalog.album({ artist: 'Band', title: 'Record (Live at the venue)', trackCount: 9 }), null);
  assert.equal((await catalog.album({ artist: 'Band', title: 'One', trackCount: 1 })).groupId, 'single');
});

test('persistent cache distinguishes misses from errors, shares concurrent callers and serves older data after timeouts', async t => {
  const dir = await cleanup(t);
  let now = Date.now();
  let lookups = 0;
  const cache = new LocalMusicCache(dir, { now: () => now });
  const lookup = () => { lookups++; return { label: 'Atlantic' }; };
  const [first, second] = await Promise.all([cache.result('cover', lookup), cache.result('cover', lookup)]);
  assert.deepEqual(first, second);
  assert.equal(lookups, 1);
  const reopened = new LocalMusicCache(dir, { now: () => now });
  assert.deepEqual(await reopened.result('cover', () => assert.fail('cache not used')), first);
  now += 89 * DAY;
  assert.deepEqual(await reopened.result('cover', () => assert.fail('expired before 90 days')), first);
  now += 2 * DAY;
  const retryAt = now + DAY;
  const offline = () => { throw Object.assign(new Error('503'), { retryAfter: retryAt }); };
  assert.deepEqual(await reopened.result('cover', offline), { ...first, retryAt });
  assert.deepEqual(await reopened.result('cover', () => assert.fail('retry too soon')), { ...first, retryAt });
  assert.deepEqual(await reopened.result('miss', () => null), { status: 'notFound' });
  assert.deepEqual(await reopened.result('miss', () => assert.fail('negative cache not used')), { status: 'notFound' });
  assert.equal((await reopened.result('new', offline)).status, 'temporaryError');
  now += DAY + 1000;
  assert.equal((await reopened.result('miss', lookup)).status, 'found');
});

test('persistent cache evicts by last access within its byte budget', async t => {
  const dir = await cleanup(t);
  let now = Date.now();
  const cache = new LocalMusicCache(dir, { now: () => now, maxBytes: 360 });
  await cache.result('older', () => 'a'.repeat(70));
  now += 1000;
  await cache.result('newer', () => 'b'.repeat(70));
  now += 1000;
  await cache.result('older', () => assert.fail('cache not used'));
  now += 1000;
  await cache.result('latest', () => 'c'.repeat(70));
  assert.equal((await fs.readdir(dir)).length, 2);
  assert.equal((await cache.result('older', () => assert.fail('LRU removed recently touched record'))).status, 'found');
  assert.equal((await cache.result('newer', () => null)).status, 'notFound');
});

test('cover order skips the HTTP 200 stock placeholder and uses embedded JPEG before remote lookup', async t => {
  const dir = await cleanup(t);
  const service = new LocalMusicService({}, dir, {
    library: { resolve: async () => localEntity, fileMetadata: async () => ({ file: '/audio.flac', picture: 1 }) },
    catalog: { album: async () => assert.fail('catalog should not be used'), stop() {} },
    image: async ({ file }) => file ? jpeg : null,
    fetcher: async () => new Response('<svg><g /></svg>', { headers: { 'Content-Type': 'image/svg+xml' } })
  });
  const reply = await service.resolve(request(['cover']));
  assert.equal(reply.fields.cover.value.source, 'embedded');
  assert.deepEqual(Buffer.from(reply.fields.cover.value.jpeg, 'base64'), jpeg);
});

test('working Volumio art retains its URL and never opens the audio file', async t => {
  const dir = await cleanup(t);
  const service = new LocalMusicService({}, dir, {
    library: { resolve: async () => localEntity, fileMetadata: async () => assert.fail('stock art has priority') },
    catalog: { album: async () => assert.fail('stock art has priority'), stop() {} },
    image: async () => jpeg,
    fetcher: async url => new Response(String(url).endsWith(localEntity.art) ? jpeg : Buffer.from([255, 216, 255, 219, 7]),
      { headers: { 'Content-Type': 'image/jpeg' } })
  });
  const reply = await service.resolve(request(['cover']));
  assert.deepEqual(reply.fields.cover, { status: 'found', value: { source: 'volumio', url: localEntity.art } });
});

test('one result can contain a JPEG, local year and a temporary metadata error', async t => {
  const dir = await cleanup(t);
  const service = new LocalMusicService({}, dir, {
    library: { resolve: async () => ({ ...localEntity, art: '' }), fileMetadata: async () => ({ file: '/audio.flac', picture: 1 }) },
    catalog: { album: async () => { throw new Error('MusicBrainz HTTP 503'); }, stop() {} },
    image: async () => jpeg
  });
  const result = await service.resolve(request(['cover', 'albumInfo']));
  assert.equal(result.fields.cover.status, 'found');
  assert.equal(result.fields.albumInfo.status, 'found');
  assert.deepEqual(result.fields.albumInfo.value, { localYear: '2001', summaryStatus: 'temporaryError' });
  assert.ok(result.fields.albumInfo.retryAt > Date.now());
});

test('release cover 404 uses the group image while Wikipedia failure leaves the edition and label', async t => {
  const dir = await cleanup(t);
  const images = [];
  const service = new LocalMusicService({}, dir, {
    library: { resolve: async () => ({ ...localEntity, art: '' }), fileMetadata: async () => null },
    catalog: {
      album: async () => ({ groupId: 'group', releaseId: 'release', label: 'Atlantic', year: '1999' }),
      image: async (kind, id) => {
        images.push([kind, id]);
        return kind === 'release' ? null : { body: jpeg };
      },
      summary: async () => { throw new Error('Wikipedia HTTP 503'); },
      stop() {}
    },
    image: async ({ body }) => body
  });
  const result = await service.resolve(request(['cover', 'albumInfo']));
  assert.deepEqual(images, [['release', 'release'], ['release-group', 'group']]);
  assert.equal(result.fields.cover.value.source, 'releaseGroup');
  assert.equal(result.fields.albumInfo.value.label, 'Atlantic');
  assert.equal(result.fields.albumInfo.value.summaryStatus, 'temporaryError');
});

test('album without a known artist is never sent to an external provider', async t => {
  const dir = await cleanup(t);
  const service = new LocalMusicService({}, dir, {
    library: { resolve: async () => ({ ...localEntity, art: '', artist: '' }), fileMetadata: async () => null },
    catalog: { album: async () => assert.fail('no external lookup'), artist: async () => assert.fail('no external lookup'), stop() {} }
  });
  const result = await service.resolve(request(['cover', 'albumInfo', 'artistInfo']));
  assert.equal(result.fields.cover.status, 'notFound');
  assert.equal(result.fields.artistInfo.status, 'notFound');
  assert.deepEqual(result.fields.albumInfo, { status: 'found', value: { localYear: '2001' } });
  assert.equal((await service.resolve(request(['cover'], { locale: 'invalid locale' }))).error, 'invalidRequest');
});

test('remote loader enforces host and byte limits after redirects', async () => {
  await assert.rejects(remote('https://coverartarchive.org/release/x/front-500', {
    fetcher: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3000' } }),
    allowHost: host => host === 'coverartarchive.org'
  }), /unexpected redirect host/);
  await assert.rejects(remote('https://coverartarchive.org/release/x/front-500', {
    maxBytes: 3, fetcher: async () => new Response('too big')
  }), /too large/);
  assert.equal(await convertImage({ body: Buffer.from('<svg/>') }), null);
});
