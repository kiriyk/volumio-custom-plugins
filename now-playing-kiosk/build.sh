#!/bin/bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "$0")" && pwd -P)
source "$HERE/base.env"
OUT=$(realpath -m -- "${1:-$HERE/dist}")
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

checkout() {
  local path=$1 url=$2 revision=$3
  git init -q "$path"
  git -C "$path" fetch -q --depth=1 "$url" "$revision"
  git -C "$path" checkout -q --detach FETCH_HEAD
  test "$(git -C "$path" rev-parse HEAD)" = "$revision"
}

checkout "$WORK/server" "${NP_SERVER_REPO:-https://github.com/patrickkfkan/volumio-now-playing.git}" "$SERVER_REV"
checkout "$WORK/client" "${NP_CLIENT_REPO:-https://github.com/patrickkfkan/volumio-now-playing-reactjs-client.git}" "$CLIENT_REV"
for project in server client; do
  git -C "$WORK/$project" apply --check "$HERE/patches/$project.patch"
  git -C "$WORK/$project" apply "$HERE/patches/$project.patch"
done

test "$(cd "$WORK/server" && node -p 'require("./package.json").version')" = "$OFFICIAL_VERSION"
test "$(cd "$WORK/client" && node -p 'require("./package.json").version')" = "$CLIENT_VERSION"
mkdir -p "$WORK/official"
git -C "$WORK/server" archive HEAD dist | tar -x -C "$WORK/official"
(cd "$WORK/client" && npm ci --no-audit --no-fund && npm run build)
rm -rf -- "$WORK/server/src/app/client/build"
cp -a -- "$WORK/client/build" "$WORK/server/src/app/client/build"
(cd "$WORK/server" && npm ci --no-audit --no-fund && npm run build)

RELEASE="$WORK/now-playing-kiosk"
mkdir "$RELEASE"
cp "$HERE/install.py" "$HERE/README.md" "$RELEASE/"
python3 "$HERE/package.py" "$WORK/official" "$WORK/server" "$RELEASE" \
  "$OFFICIAL_VERSION" "$SERVER_REV" "$CLIENT_REV" "$KIOSK_VERSION"
ARCHIVE="$OUT/now-playing-kiosk-$KIOSK_VERSION-volumio-$OFFICIAL_VERSION.tar.gz"
tar -czf "$ARCHIVE.tmp" -C "$WORK" now-playing-kiosk
mv -f -- "$ARCHIVE.tmp" "$ARCHIVE"
(cd "$OUT" && sha256sum "$(basename "$ARCHIVE")") > "$ARCHIVE.sha256"
printf '%s\n' "$ARCHIVE"
