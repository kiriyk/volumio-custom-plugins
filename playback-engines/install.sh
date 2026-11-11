#!/bin/bash
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"
set -euo pipefail
if [ "$(id -u)" != 0 ]; then echo 'Run the installer as root.' >&2; exit 1; fi
PLUGIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
STATE_DIR=/data/configuration/audio_interface/playback_engines
. /etc/os-release
if [ "${VERSION_CODENAME:-}" != bookworm ] || [[ "${VOLUMIO_VERSION:-}" != 4.* ]]; then
  echo 'Volumio 4 / Bookworm is required.' >&2; exit 1
fi
if [ "$(dpkg --print-architecture)" != armhf ]; then echo 'Playback Engines currently requires ARMHF.' >&2; exit 1; fi
node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
if [ "$(id -u volumio)" != 1000 ]; then echo 'Expected Volumio user with UID 1000.' >&2; exit 1; fi
missing=()
for package in python3 libasound2 ffmpeg ca-certificates; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then missing+=("$package"); fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
fi
python3 -c 'import sys; assert sys.version_info >= (3, 11)'
command -v ffprobe >/dev/null
python3 "$PLUGIN_DIR/scripts/install_renderer.py" "$STATE_DIR"
chown -R volumio:volumio "$STATE_DIR"
chmod 700 "$STATE_DIR" "$STATE_DIR/renderer"
# Settings, accounts and per-engine profiles are never initialized or overwritten here.
install -d -m 755 /etc/systemd/system /etc/sudoers.d
UNIT_TEMP=$(mktemp)
SUDOERS_TEMP=$(mktemp)
trap 'rm -f "$UNIT_TEMP" "$SUDOERS_TEMP"' EXIT
sed "s|@STATE_DIR@|$STATE_DIR|g" "$PLUGIN_DIR/systemd/volumio-playback-renderer.service" > "$UNIT_TEMP"
printf '%s\n' 'volumio ALL=(root) NOPASSWD: /bin/systemctl start volumio-playback-renderer.service, /bin/systemctl stop volumio-playback-renderer.service' > "$SUDOERS_TEMP"
visudo -cf "$SUDOERS_TEMP"
install -m 644 "$UNIT_TEMP" /etc/systemd/system/volumio-playback-renderer.service
install -m 440 "$SUDOERS_TEMP" /etc/sudoers.d/volumio-playback-renderer
systemctl daemon-reload
echo 'Playback Engines installed. Renderer starts only when explicitly selected in plugin settings.'
echo 'plugininstallend'
