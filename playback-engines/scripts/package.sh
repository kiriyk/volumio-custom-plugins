#!/bin/bash
set -euo pipefail
PLUGIN_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$PLUGIN_DIR"
VERSION=$(node -p 'require("./package.json").version')
mkdir -p dist
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/playback_engines/lib/engines"
files=(package.json package-lock.json index.js config.json lib service systemd scripts/install_renderer.py scripts/update.js install.sh uninstall.sh)
for item in UIConfig.json i18n README.md VERIFYING-AUDIO.md LICENSE NOTICE; do
  if [ -e "$item" ]; then files+=("$item"); fi
done
tar --exclude='__pycache__' --exclude='*.pyc' --exclude='node_modules' --exclude='tests' \
  --exclude='config.dat' --exclude='ap2renderer' --exclude='settings.json' --exclude='credentials.json' \
  --exclude='*.tar.gz' --exclude='*.zip' -cf - "${files[@]}" | tar -xf - -C "$STAGING/playback_engines"
cp "$PLUGIN_DIR/../shared/playback/"*.js "$STAGING/playback_engines/lib/engines/"
tar -czf "dist/playback_engines-$VERSION.tar.gz" -C "$STAGING" playback_engines
printf '%s\n' "$PLUGIN_DIR/dist/playback_engines-$VERSION.tar.gz"
