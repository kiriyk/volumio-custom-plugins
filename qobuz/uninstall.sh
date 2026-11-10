#!/bin/bash
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec sudo bash "$0" "$@"; fi
PLUGIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
INSTALL_ROOT=${DESTDIR:-}
systemctl stop volumio-qobuz-custom.service || true
rm -f "$INSTALL_ROOT/etc/systemd/system/volumio-qobuz-custom.service" "$INSTALL_ROOT/etc/sudoers.d/volumio-qobuz-custom"
systemctl daemon-reload
rm -rf "$PLUGIN_DIR/.venv" "$INSTALL_ROOT/data/configuration/music_service/qobuz_custom"
echo 'Qobuz Custom and its saved sign-in removed.'
echo 'pluginuninstallend'
