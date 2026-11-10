#!/bin/bash
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec sudo bash "$0" "$@"; fi
PLUGIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
INSTALL_ROOT=${DESTDIR:-}
systemctl stop volumio-yandex.service || true
systemctl disable volumio-yandex.service 2>/dev/null || true
rm -f "$INSTALL_ROOT/etc/systemd/system/volumio-yandex.service"
rm -f "$INSTALL_ROOT/etc/sudoers.d/volumio-yandex"
systemctl daemon-reload
rm -rf "$PLUGIN_DIR/.venv"
rm -rf "$INSTALL_ROOT/data/configuration/music_service/yandex_music"
echo 'Yandex Music service and local credentials removed.'
echo 'pluginuninstallend'
