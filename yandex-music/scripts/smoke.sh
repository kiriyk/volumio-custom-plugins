#!/bin/bash
set -euo pipefail
curl --fail --silent --show-error http://127.0.0.1:17899/health
printf '\n'
systemctl is-active volumio-yandex.service
systemctl show volumio-yandex.service -p User -p MemoryCurrent
