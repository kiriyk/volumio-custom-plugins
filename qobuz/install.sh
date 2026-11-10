#!/bin/bash
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec sudo bash "$0" "$@"; fi
PLUGIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
INSTALL_ROOT=${DESTDIR:-}
STATE_DIR="$INSTALL_ROOT/data/configuration/music_service/qobuz_custom"
node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
python3 -c 'import sys; assert sys.version_info >= (3, 11)'
. "$INSTALL_ROOT/etc/os-release"
if [ "${VERSION_CODENAME:-}" != bookworm ] || [[ "${VOLUMIO_VERSION:-}" != 4.* ]]; then
  echo 'Volumio 4 / Bookworm is required.' >&2; exit 1
fi
case "$(dpkg --print-architecture)" in armhf|amd64) ;; *) exit 1 ;; esac
missing=0
for package in python3-venv python3-dev build-essential; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then missing=1; fi
done
if [ "$missing" = 1 ]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv python3-dev build-essential
fi
python3 "$PLUGIN_DIR/scripts/bootstrap.py" "$STATE_DIR" "$INSTALL_ROOT/data/qobuz-research"
chown -R volumio:volumio "$STATE_DIR"
python3 -m venv "$PLUGIN_DIR/.venv"
"$PLUGIN_DIR/.venv/bin/python" -m pip install --disable-pip-version-check --prefer-binary -r "$PLUGIN_DIR/service/requirements.txt"
chown -R volumio:volumio "$PLUGIN_DIR/.venv"
install -d "$INSTALL_ROOT/etc/systemd/system"
sed -e "s|@PLUGIN_DIR@|$PLUGIN_DIR|g" -e "s|@STATE_DIR@|$STATE_DIR|g" \
  "$PLUGIN_DIR/systemd/volumio-qobuz-custom.service" > "$INSTALL_ROOT/etc/systemd/system/volumio-qobuz-custom.service"
chmod 644 "$INSTALL_ROOT/etc/systemd/system/volumio-qobuz-custom.service"
install -d -m 755 "$INSTALL_ROOT/etc/sudoers.d"
SUDOERS_TEMP=$(mktemp)
trap 'rm -f "$SUDOERS_TEMP"' EXIT
printf '%s\n' 'volumio ALL=(root) NOPASSWD: /bin/systemctl start volumio-qobuz-custom.service, /bin/systemctl stop volumio-qobuz-custom.service' > "$SUDOERS_TEMP"
visudo -cf "$SUDOERS_TEMP"
install -m 440 "$SUDOERS_TEMP" "$INSTALL_ROOT/etc/sudoers.d/volumio-qobuz-custom"
systemctl daemon-reload
echo 'Qobuz Custom installed. Enable the plugin in Volumio.'
echo 'plugininstallend'
