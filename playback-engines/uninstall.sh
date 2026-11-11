#!/bin/bash
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"
set -euo pipefail
if [ "$(id -u)" != 0 ]; then echo 'Run the uninstaller as root.' >&2; exit 1; fi
STATE_DIR=/data/configuration/audio_interface/playback_engines
systemctl stop volumio-playback-renderer.service || true
# Normally onStop restores MPD. This fallback only restores our saved pre-plugin
# configuration if the plugin-managed output marker is still present. It is the
# sole case where uninstall restarts MPD; queues and saved profiles stay intact.
if [ -f "$STATE_DIR/mpd.conf.before-plugin" ] && [ -f /etc/mpd.conf ] && grep -q 'name[[:space:]]*"Playback Engines"' /etc/mpd.conf; then
  if [ -L "$STATE_DIR/mpd.conf.before-plugin" ] || [ -L /etc/mpd.conf ]; then
    echo 'Refusing symbolic link in MPD restoration paths.' >&2; exit 1
  fi
  install -m 644 "$STATE_DIR/mpd.conf.before-plugin" /etc/mpd.conf
  systemctl restart mpd.service
fi
rm -f /etc/systemd/system/volumio-playback-renderer.service /etc/sudoers.d/volumio-playback-renderer
systemctl daemon-reload
echo 'Playback Engines removed. Saved state and profiles preserved.'
echo 'pluginuninstallend'
