# Yandex Music for Volumio 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Install a native Yandex Music source with device login, search, collection and MP3 playback on the owner's Raspberry Pi.

**Architecture:** CommonJS Volumio adapter calls a persistent loopback aiohttp service. Python owns credentials and Yandex API calls; MPD plays bounded streaming responses. No changes to Core or global audio settings.

**Tech Stack:** Node >=20, Python >=3.11, aiohttp, yandex-music 3.2.2, node:test, pytest/pytest-asyncio, systemd.

**Spec:** `docs/superpowers/specs/2026-11-09-yandex-music-design.md`.

## Global Constraints

- Volumio 4 / Bookworm; actual target 4.239, Node 20.5.1, Python 3.11.2, armhf.
- Bind 127.0.0.1:17899; authenticate control API with a local secret.
- Page size 50, max 100; maximum queue expansion 2000 tracks, explicit errors.
- Single account, collection read-only; no wave, FLAC, encoder or separate frontend.
- Credentials mode 0600, atomic writes, never included in logs/config/UI responses.
- MP3 up to 320 kbps; no transcoding or resampling.
- Runtime dependencies locked; armhf installs use target-native dependencies.

## Review Focus

- A late stream resolution must never restart music after stop/next/source change.
- Broken OAuth or signed upstream URLs must never leak tokens through exceptions/logs.
- Range, HEAD and upstream disconnects must preserve valid HTTP and bounded buffering.
- Empty/partial collections, unavailable tracks and duplicate playlist entries must retain usable navigation and correct queue order.
- Lifecycle and upgrade must preserve credentials while uninstall removes them and never stops another source.

## File map

- `service/{app,auth,backend,catalog,streaming,storage,errors}.py`: HTTP composition, auth lifecycle, SDK adapter, DTOs, proxy, credentials and public errors.
- `lib/{api-client,browse,playback,track-mapper}.js`, `index.js`: Volumio boundary.
- `UIConfig.json`, `config.json`, `i18n/`: native settings.
- `install.sh`, `uninstall.sh`, `systemd/volumio-yandex.service`, `scripts/`: packaging and deployment.
- `tests/python/`, `tests/node/`: offline behavior/contract tests; `docs/`: installation and live verification.

### Task 1: Python auth and catalog

**Files:** `service/errors.py`, `service/storage.py`, `service/auth.py`, `service/backend.py`, `service/catalog.py`, `tests/python/test_auth.py`, `tests/python/test_catalog.py`, `pyproject.toml`, `requirements*.txt`.

**Interfaces:** `CredentialStore.load/save/clear`; `AuthManager.start/status/login_token/logout/require_client`; `YandexBackend.search/library/playlist/album/artist/tracks/resolve`; normalized dicts as spec; `ServiceError(code,message,status)`.

- [x] Write tests for file permissions, preservation after failed login, device cancellation, sanitized failures, collection/search DTOs, stable IDs and unavailable tracks.
- [x] Run `uv run pytest tests/python/test_auth.py tests/python/test_catalog.py -q`; expect failing missing implementation.
- [x] Implement storage and async auth lifecycle, refresh grant, SDK adapter and DTO normalization. Read installed SDK signatures; never infer account/playlist response shapes.
- [x] Run those tests green, including empty/partial responses and duplicate playlist IDs.
- [x] Commit `feat: implement authenticated Yandex catalog service`.

### Task 2: HTTP service and streaming

**Files:** `service/app.py`, `service/streaming.py`, `tests/python/test_http.py`, `tests/python/test_streaming.py`, `tests/fixtures/`.

**Interfaces:** `create_app(backend, state_dir, api_key, upstream_policy=None) -> web.Application`; `/health`, authenticated `/v1/*` resources; `POST /v1/playback/resolve {track_id}` produces local ticket URL; `GET/HEAD /stream/{ticket}`.

- [x] Write real local HTTP tests for control auth, paging/limits, JSON errors, login endpoints and ticket invalidation on logout.
- [x] Write proxy tests for identical bytes, HEAD, valid/malformed ranges, 416, redirects, expired URL refresh and consumer cancellation; upstream bodies are generated in chunks.
- [x] Run `uv run pytest tests/python/test_http.py tests/python/test_streaming.py -q`; expect missing routes/proxy failure.
- [x] Implement bounded aiohttp proxy (64 KiB chunks), strict upstream URL policy, timeout/connection cleanup, bounded tickets/cache and safe error middleware. Bind loopback, reject unexpected Host/Origin on control actions.
- [x] Run `uv run pytest -q` green.
- [x] Commit `feat: add local catalog API and bounded audio streaming`.

### Task 3: Native Volumio adapter

**Files:** `index.js`, `lib/*.js`, `package.json`, `package-lock.json`, settings/i18n, `tests/node/*.test.js`.

**Interfaces:** `ApiClient.request(method,path,body)`, `Browse.browse(uri)/search(query)/explode(uri)`, `Playback.clearAddPlayTrack/stop/pause/resume/seek`, Volumio lifecycle and settings callbacks.

- [x] Write tests for stable queue URIs/metadata, all browse paths, next-page URIs, playlist order, and proper Volumio list return shapes.
- [x] Write playback tests for consume-mode MPD delegation, stale async response suppression after stop/source switch and handled resolver failure.
- [x] Write lifecycle/settings tests for service readiness, source registration/removal, signed-out mode and write-only token input.
- [x] Run `node --test tests/node/*.test.js`; expect missing modules.
- [x] Implement adapter using verified installed MPD/state-machine contracts; timers/cancellation owned by lifecycle, all outward async methods kew-compatible.
- [x] Run `npm test` green and one Node → actual local Python fake-backend integration test.
- [x] Commit `feat: integrate Yandex Music into Volumio browse and queue`.

### Task 4: Installable release and operations

**Files:** `install.sh`, `uninstall.sh`, `systemd/volumio-yandex.service`, `scripts/{package,deploy,smoke}.sh`, `README.md`, `docs/testing.md`, `tests/python/test_install.py`.

**Interfaces:** `volumio plugin install` supported package, own unit started only by plugin, idempotent state directory setup; release excludes credentials/build environments.

- [x] Write shell behavior tests against fake commands/filesystem for wrong runtime, stopped-on-install unit, update preservation and uninstall cleanup; run RED.
- [x] Implement preflight, venv prerequisites, target-native pinned dependency installation, service unit, packaging and documented update/rollback path.
- [x] Run `bash -n install.sh uninstall.sh scripts/*.sh`, `npm test`, `uv run pytest -q`, build package and inspect exclusions.
- [x] Commit `feat: package plugin for installation on Raspberry Pi`.

### Task 5: Raspberry Pi verification and review

**Files:** `docs/compatibility.md`, `docs/testing.md`, any integration fixes with regression tests.

**Interfaces:** actual Volumio 4.239 plugin manager and UI, target Python venv and MPD; manual owner confirmation for Yandex account/device code.

- [x] Deploy tested package, install, enable; verify health, source, settings and signed-out behavior over actual Volumio API.
- [x] Exercise enable/disable/re-enable and update preservation; verify uninstall then reinstall before account login. Do not reset existing audio settings.
- [x] Expose device code/URL to owner; continue independent checks while owner authorizes. Real account tests remain explicitly pending until credentials available.
- [x] Run real search/collection/playback/seek/queue tests where credentials and output available; record measured results and pending manual listening/30-minute soak honestly.
- [x] Run whole offline suite and fresh reviewer against spec/plan; fix important findings with regression tests, record rulings.
- [x] Commit verified integration changes and document final release state.

## Execution decisions

User explicitly requested implementation after the written design. Execute inline without another plan approval prompt. The repository is a new standalone directory dedicated to this feature; use branch `feat/yandex-music-v1` in place, preserving its location, rather than creating a second checkout.
