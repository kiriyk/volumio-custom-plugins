import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showDownloads, showTrackColumns } from '../src/core/browsePresentation.ts';
const songs = {items:[{type:'song'},{type:'song'}]};
const rows = {searching:false,artist:false,downloads:false,grid:false};
test('downloads are confined to their own page', () => {
  assert.equal(showDownloads('qobuz_custom/downloads'),true);
  for (const uri of ['', 'qobuz_custom', 'qobuz_custom/album/abc', 'yandex_music', 'search']) assert.equal(showDownloads(uri),false);
});
test('columns require exactly one uniform track list in row view', () => {
  assert.equal(showTrackColumns([songs],rows),true);
  for (const key of ['searching','artist','downloads','grid']) assert.equal(showTrackColumns([songs],{...rows,[key]:true}),false);
  for (const lists of [[],[songs,songs],[{items:[{type:'song'},{type:'folder'}]}],[{items:[]}]]) assert.equal(showTrackColumns(lists,rows),false);
});
