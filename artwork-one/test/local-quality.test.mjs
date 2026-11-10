import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalQuality } from '../src/core/localQuality.ts';

test('shows measured bitrate and size, omitting unavailable values', () => {
  assert.equal(formatLocalQuality({ size: 10485760, bitrate: 960000 }), '960 кбит/с · 10 МиБ');
  assert.equal(formatLocalQuality({ size: 1048576, bitrate: null }), '1 МиБ');
  assert.equal(formatLocalQuality({ size: null, bitrate: null }), '');
});
