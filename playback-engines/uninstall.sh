#!/bin/bash
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"
set -euo pipefail
if [ "$(id -u)" != 0 ]; then echo 'Run the uninstaller as root.' >&2; exit 1; fi
STATE_DIR=/data/configuration/audio_interface/playback_engines
systemctl stop volumio-playback-renderer.service || true
systemctl stop volumio-playback-aplayer.service volumio-playback-aplayer-proxy.socket volumio-playback-aplayer-proxy.service || true
if [ -d "$STATE_DIR/aplayer-slot" ] && [ ! -L "$STATE_DIR/aplayer-slot" ]; then
  find "$STATE_DIR/aplayer-slot" -maxdepth 1 -type l -name 'track-*' -delete
  rmdir "$STATE_DIR/aplayer-slot" 2>/dev/null || true
fi
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
rm -f /etc/systemd/system/volumio-playback-renderer.service /etc/sudoers.d/volumio-playback-renderer \
  /etc/systemd/system/volumio-playback-aplayer.service \
  /etc/systemd/system/volumio-playback-aplayer-proxy.service \
  /etc/systemd/system/volumio-playback-aplayer-proxy.socket
systemctl daemon-reload
echo 'Playback Engines removed. Saved state and profiles preserved.'
echo 'pluginuninstallend'
