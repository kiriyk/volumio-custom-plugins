# Qobuz Minimal Implementation Plan

> Execute inline with superpowers:executing-plans. User authorized continuation, installation and preservation in the public monorepo.

**Goal:** Install a minimal independent Qobuz source with the existing account, album search and native Volumio queue playback.

**Architecture:** Node Volumio adapter and isolated Python/aiohttp API + streaming service. Reuse proven MIT Yandex boundary/playback/proxy patterns; implement Qobuz authentication, metadata and signing separately.

**Tech Stack:** Node >=20, Python >=3.11, aiohttp, Volumio 4 / Bookworm, MPD.

**Spec:** `../specs/2026-11-10-qobuz-minimal-design.md`

## Global Constraints

- Service `qobuz_custom`; API 127.0.0.1:17901; OAuth callback port 17900.
- No secrets in package, logs or DTOs; state 0700/0600; no changes to main playback during installation.
- FLAC only; actual codec/rate/depth; session invalidation cancels old tickets.
- No dependency on premium modules or Yandex plugin runtime.

## Review Focus

- Late resolve after stop/source switch must not call MPD play.
- Qobuz format 27 can return format 7: preserve measured/reported actual values.
- Album IDs are opaque strings; track IDs are numeric; avoid truncated multi-page queues.
- OAuth callback is one-use, expires and never emits raw API errors.
- Reject foreign stream URLs, redirects, malformed ranges and cross-origin control calls.

### Task 1: Qobuz protocol and state

Files: `qobuz/service/provider.py`, `storage.py`, `errors.py`, `tests/test_provider.py`.

Interfaces: async `Provider.search(query, kind, offset, limit)`, `album(id, offset, limit)`, `library(offset, limit)`, `resolve(id, quality)`, `begin_login(host)`, `finish_login(code)`, `account()`, `logout()`. DTO page `{items,next_cursor}`, stream `{url,codec,bitrate,sampleRate,bitDepth}`.

- [ ] Write failing tests for French callback, atomic private storage, opaque album IDs, pagination, quality mapping and invalid stream format.
- [ ] Run `python3 -m unittest discover -s qobuz/tests -p 'test_*.py'` (expect failures before implementation).
- [ ] Implement focused provider/state modules, with injected async HTTP transport for protocol tests.
- [ ] Run those tests (expect pass); commit backend protocol.

### Task 2: Local API, transport, Volumio integration

Files: `qobuz/service/app.py`, `streaming.py`, `qobuz/index.js`, `lib/`, `tests/test_app.py`, `tests/node/`.

Interfaces: `/health`, keyed `/v1/account`, `/v1/auth/{start,logout}`, `/v1/search`, `/v1/albums/{id}`, `/v1/library/albums`, `/v1/playback/resolve`, `/stream/{ticket}`. Node browse URI prefix `qobuz_custom` and quality event `pushQobuzCustomQuality`.

- [ ] Add failing tests for stale playback, URI mapping, loopback authorization, range forwarding and callback replay.
- [ ] Implement API, one-use callback, bounded streaming and native source lifecycle by adapting Yandex modules.
- [ ] Run Python and Node suites once changes are complete; resolve any failures before proceeding.
- [ ] Commit native source and service.

### Task 3: Installable package and Artwork One

Files: `qobuz/{install.sh,uninstall.sh,package.json,UIConfig.json,config.json,README.md,systemd/,scripts/,i18n/}`, `artwork-one/src/` search/quality/source glue, package artifacts.

- [ ] Add installer smoke check for private research-session import and preservation on update; add UI helper tests where behavior changes.
- [ ] Implement isolated service installation, update/package scripts and independent quality/search UI wiring.
- [ ] Build packages and theme, run targeted tests; review final diff and package members for private files.
- [ ] Deploy source and theme through existing installation paths, retaining account and avoiding Volumio restart. Verify health/account/search/album/resolve on device; use test MPD rather than main queue for audio.
- [ ] Save outcomes, exact limitations and restoration instructions; commit and push all public artifacts.

## Execution ledger

Initial ruling: execute in one feature worktree, no per-task agents or repeated baseline suites. Tests cover new boundaries and behavior, not copied implementation details. User's standing authorization covers installing and publishing completed plugins. Staged design is based on the already accepted independent-client approach.
