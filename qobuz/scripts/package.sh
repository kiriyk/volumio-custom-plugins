#!/bin/bash
set -euo pipefail
REPO_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$REPO_DIR"
VERSION=$(node -p 'require("./package.json").version')
mkdir -p dist
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir "$STAGING/qobuz_custom"
tar --exclude='__pycache__' --exclude='*.pyc' --exclude='credentials.json' --exclude='api-key' \
  -cf - package.json package-lock.json index.js config.json UIConfig.json lib i18n service \
  systemd scripts/update.js scripts/bootstrap.py install.sh uninstall.sh README.md LICENSE NOTICE | tar -xf - -C "$STAGING/qobuz_custom"
mkdir -p "$STAGING/qobuz_custom/lib/engines"
cp "$REPO_DIR/../shared/playback/"*.js "$STAGING/qobuz_custom/lib/engines/"
tar -czf "dist/qobuz_custom-$VERSION.tar.gz" -C "$STAGING" qobuz_custom
printf '%s\n' "$REPO_DIR/dist/qobuz_custom-$VERSION.tar.gz"
