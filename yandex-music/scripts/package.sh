#!/bin/bash
set -euo pipefail
REPO_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$REPO_DIR"
VERSION=$(node -p 'require("./package.json").version')
mkdir -p dist
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir "$STAGING/yandex_music"
tar --exclude='__pycache__' --exclude='*.pyc' --exclude='credentials.json' --exclude='api-key' \
  -cf - package.json package-lock.json index.js config.json UIConfig.json lib i18n service \
  systemd scripts/update.js scripts/repair-volumio-discovery.py install.sh uninstall.sh README.md LICENSE | tar -xf - -C "$STAGING/yandex_music"
mkdir -p "$STAGING/yandex_music/lib/engines"
cp "$REPO_DIR/../shared/playback/"*.js "$STAGING/yandex_music/lib/engines/"
tar -czf "dist/yandex_music-$VERSION.tar.gz" -C "$STAGING" yandex_music
printf '%s\n' "$REPO_DIR/dist/yandex_music-$VERSION.tar.gz"
