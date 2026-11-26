'use strict';
// One observer hub per native MPD instance, shared even by separately bundled
// plugin copies. Closing a source cannot invalidate another source's parser.
const KEY = Symbol.for('volumio-custom-plugins.mpd-events.v1');
module.exports = function subscribe(mpd, listener) {
  if (typeof mpd?.parseState !== 'function') return () => {};
  let hub = mpd[KEY];
  if (!hub) {
    const original = mpd.parseState;
    hub = { listeners: new Set(), original };
    hub.parse = function (raw) {
      const state = original.call(this, raw);
      for (const callback of [...hub.listeners]) callback(raw, state);
      return state;
    };
    mpd[KEY] = hub; mpd.parseState = hub.parse;
  }
  hub.listeners.add(listener);
  return () => {
    hub.listeners.delete(listener);
    if (!hub.listeners.size) {
      if (mpd.parseState === hub.parse) mpd.parseState = hub.original;
      if (mpd[KEY] === hub) delete mpd[KEY];
    }
  };
};
