'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = require(fs.existsSync(path.join(__dirname, 'engines/index.js')) ? './engines' : '../../shared/playback');
