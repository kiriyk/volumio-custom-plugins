#!/bin/bash
set -euo pipefail
TARGET=${1:-volumio@volumio.local}
if [[ ! "$TARGET" =~ ^[a-zA-Z0-9_.@:-]+$ ]]; then echo 'Invalid SSH target' >&2; exit 1; fi
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
ARCHIVE=$(bash "$SCRIPT_DIR/package.sh")
scp "$ARCHIVE" "$TARGET:/tmp/qobuz_custom-release.tar.gz"
ssh -t "$TARGET" 'set -e; mkdir -p /data/qobuz_custom-releases; RELEASE_DIR=$(mktemp -d /data/qobuz_custom-releases/release.XXXXXX); tar -xzf /tmp/qobuz_custom-release.tar.gz -C "$RELEASE_DIR"; cd "$RELEASE_DIR/qobuz_custom"; if [ -f /data/plugins/music_service/qobuz_custom/package.json ]; then node scripts/update.js .; else volumio plugin install; fi'
