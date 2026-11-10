#!/bin/bash
set -euo pipefail
TARGET=${1:-volumio@volumio.local}
if [[ ! "$TARGET" =~ ^[a-zA-Z0-9_.@:-]+$ ]]; then echo 'Invalid SSH target' >&2; exit 1; fi
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
ARCHIVE=$(bash "$SCRIPT_DIR/package.sh")
scp "$ARCHIVE" "$TARGET:/tmp/yandex_music-release.tar.gz"
ssh -t "$TARGET" 'set -e; mkdir -p /data/yandex_music-releases; RELEASE_DIR=$(mktemp -d /data/yandex_music-releases/release.XXXXXX); tar -xzf /tmp/yandex_music-release.tar.gz -C "$RELEASE_DIR"; cd "$RELEASE_DIR/yandex_music"; if [ -f /data/plugins/music_service/yandex_music/package.json ]; then node scripts/update.js .; else volumio plugin install; fi'
