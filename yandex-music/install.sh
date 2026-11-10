#!/bin/bash
[ -n "${BASH_VERSION:-}" ] || exec /bin/bash "$0" "$@"
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec sudo bash "$0" "$@"; fi
PLUGIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
INSTALL_ROOT=${DESTDIR:-}
STATE_DIR="$INSTALL_ROOT/data/configuration/music_service/yandex_music"
UNIT_DIR="$INSTALL_ROOT/etc/systemd/system"

node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)' || {
  echo 'Node.js >=20 is required; install on Volumio 4.' >&2; exit 1;
}
python3 -c 'import sys; assert sys.version_info >= (3, 11)' || {
  echo 'Python >=3.11 is required.' >&2; exit 1;
}
OS_RELEASE="$INSTALL_ROOT/etc/os-release"
if [ ! -r "$OS_RELEASE" ]; then echo 'Cannot identify Volumio OS.' >&2; exit 1; fi
# This file is supplied by the installed OS (DESTDIR supports image staging).
. "$OS_RELEASE"
if [ "${VERSION_CODENAME:-}" != bookworm ] || [[ "${VOLUMIO_VERSION:-}" != 4.* ]]; then
  echo 'Volumio 4 / Bookworm is required.' >&2; exit 1
fi
case "$(dpkg --print-architecture)" in
  armhf|amd64) ;;
  *) echo 'Unsupported userspace architecture.' >&2; exit 1 ;;
esac

missing=0
for package in python3-venv python3-dev build-essential ffmpeg; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then missing=1; fi
done
if [ "$missing" = 1 ]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv python3-dev build-essential ffmpeg
fi

install -d -m 700 "$STATE_DIR"
python3 - "$STATE_DIR" <<'PY'
import os
import secrets
import sys
from pathlib import Path
state = Path(sys.argv[1])
key = state / 'api-key'
if not key.exists():
    fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(secrets.token_urlsafe(32))
os.chmod(key, 0o600)
credentials = state / 'credentials.json'
if credentials.exists():
    os.chmod(credentials, 0o600)
PY
chown -R volumio:volumio "$STATE_DIR"
python3 -m venv "$PLUGIN_DIR/.venv"
"$PLUGIN_DIR/.venv/bin/python" -m pip install --disable-pip-version-check --prefer-binary \
  -r "$PLUGIN_DIR/service/requirements.txt"
chown -R volumio:volumio "$PLUGIN_DIR/.venv"
install -d "$UNIT_DIR"
sed -e "s|@PLUGIN_DIR@|$PLUGIN_DIR|g" -e "s|@STATE_DIR@|$STATE_DIR|g" \
  "$PLUGIN_DIR/systemd/volumio-yandex.service" > "$UNIT_DIR/volumio-yandex.service"
chmod 644 "$UNIT_DIR/volumio-yandex.service"
install -d -m 755 "$INSTALL_ROOT/etc/sudoers.d"
SUDOERS_FILE="$INSTALL_ROOT/etc/sudoers.d/volumio-yandex"
SUDOERS_TEMP=$(mktemp)
trap 'rm -f "$SUDOERS_TEMP"' EXIT
printf '%s\n' 'volumio ALL=(root) NOPASSWD: /bin/systemctl start volumio-yandex.service, /bin/systemctl stop volumio-yandex.service' > "$SUDOERS_TEMP"
visudo -cf "$SUDOERS_TEMP"
install -m 440 "$SUDOERS_TEMP" "$SUDOERS_FILE"
systemctl daemon-reload
# Volumio's onStart/onStop owns service activation; do not enable it at boot.
echo 'Yandex Music installed. Enable the plugin in Volumio and sign in.'
echo 'plugininstallend'
