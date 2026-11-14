'use strict';

function invalid() { throw new Error('Invalid or unsupported CUE sheet'); }

function relativeFile(file) {
  // CUE filenames are literal filesystem names, not URI-encoded paths.
  if (!file || /[\x00-\x1f\x7f\\"]/.test(file) || file.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) invalid();
  return file;
}

function frames(value) {
  const match = /^(\d+):([0-5]\d):([0-7]\d)$/.exec(value);
  if (!match || Number(match[3]) > 74) invalid();
  const result = (Number(match[1]) * 60 + Number(match[2])) * 75 + Number(match[3]);
  if (!Number.isSafeInteger(result)) invalid();
  return result;
}

function parseCue(text, targetTrack) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024 || /[\x00\ufffd]/.test(text)) invalid();
  const number = typeof targetTrack === 'string' && /^track\d{4}$/.test(targetTrack) ? Number(targetTrack.slice(5)) : targetTrack;
  if (!Number.isSafeInteger(number) || number < 1 || number > 99) invalid();
  const tracks = [];
  let block = null, current = null;
  const finishTrack = () => { if (current && current.startFrame === null) invalid(); };
  const finishBlock = () => { if (block && !block.tracks.length) invalid(); };
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    const keyword = line.split(/\s/, 1)[0].toUpperCase();
    if (keyword === 'FILE') {
      finishTrack(); finishBlock();
      const match = /^FILE\s+(?:"([^"\r\n]*)"|(\S+))\s+(WAVE|FLAC|AIFF)\s*$/i.exec(line);
      if (!match) invalid();
      block = {file: relativeFile(match[1] === undefined ? match[2] : match[1]), tracks: []};
      current = null;
    } else if (keyword === 'TRACK') {
      finishTrack();
      const match = /^TRACK\s+(\d{2})\s+AUDIO$/i.exec(line);
      if (!block || !match) invalid();
      const trackNumber = Number(match[1]);
      if (!trackNumber || trackNumber <= (tracks.at(-1)?.number || 0)) invalid();
      current = {number: trackNumber, block, startFrame: null, indexes: new Map()};
      tracks.push(current); block.tracks.push(current);
    } else if (keyword === 'INDEX') {
      const match = /^INDEX\s+(\d{2})\s+(\S+)$/i.exec(line);
      if (!current || !match) invalid();
      const index = Number(match[1]), frame = frames(match[2]);
      const entries = [...current.indexes];
      const previous = entries.at(-1);
      if (current.indexes.has(index) || (previous && (index <= previous[0] || frame < previous[1]))) invalid();
      current.indexes.set(index, frame);
      if (index === 1) {
        const previousTrack = block.tracks.at(-2);
        if (previousTrack && frame <= previousTrack.startFrame) invalid();
        current.startFrame = frame;
      }
    } else if (keyword === 'PREGAP' || keyword === 'POSTGAP') {
      const match = /^(?:PREGAP|POSTGAP)\s+(\S+)$/i.exec(line);
      if (!current || !match) invalid();
      frames(match[1]);
    } else if (!['REM', 'TITLE', 'PERFORMER', 'SONGWRITER', 'CATALOG', 'CDTEXTFILE', 'ISRC', 'FLAGS'].includes(keyword)) invalid();
  }
  finishTrack(); finishBlock();
  const target = tracks.find(track => track.number === number);
  if (!target) invalid();
  const next = target.block.tracks[target.block.tracks.indexOf(target) + 1];
  return {file: target.block.file, startFrame: target.startFrame, endFrame: next ? next.startFrame : null};
}

function sampleRange(segment, rate, totalSamples) {
  if (!segment || !Number.isSafeInteger(rate) || rate <= 0 || !Number.isSafeInteger(totalSamples) || totalSamples <= 0) invalid();
  const convert = frame => {
    if (!Number.isSafeInteger(frame) || frame < 0) invalid();
    const product = BigInt(frame) * BigInt(rate);
    // Refuse fractional sample boundaries rather than silently changing CUE timing.
    if (product % 75n || product / 75n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(product / 75n);
  };
  const startSample = convert(segment.startFrame);
  const endSample = segment.endFrame === null ? totalSamples : convert(segment.endFrame);
  if (startSample >= endSample || endSample > totalSamples) invalid();
  return {startSample, endSample};
}

module.exports = {parseCue, sampleRange};
