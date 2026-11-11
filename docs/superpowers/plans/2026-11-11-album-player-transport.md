# Album Player transport implementation plan

> Execution: native, in this session. User approved proceeding after the staged implementation proposal. No additional approval gate for routine implementation.

**Goal:** Play Qobuz albums through Album Player under Volumio queue control, preserving MPD as default.
**Architecture:** Shared MPD and Album Player transports, used by the existing Qobuz/Yandex Playback adapters. Album Player receives explicit AVTransport URIs; polled state drives the existing Volumio state machine without changing its code.
**Tech stack:** Node.js >=20, HTTP SOAP, fast-xml-parser, Node test runner, installed Volumio state machine.
**Spec:** `docs/research/2026-11-11-album-player.md` and the user's approval of the staged implementation in the conversation.

## Constraints and scope

- MPD remains default; accounts and resolver APIs do not change.
- Stale resolutions and delayed controls must not start/stop another source.
- Queue navigation, repeat and shuffle remain owned by Volumio.
- Shared source is bundled into each plugin archive; standalone plugin installation must work.
- First milestone: Qobuz album, controls and queue progression, then the same boundary for Yandex.
- Later milestones remain local-library routing, settings UI, per-engine bypass/custom profiles, permanent renderer supervision and real-DAC validation. Do not represent these as completed by this milestone.
- Use a feature branch in the existing checkout; preserve the earlier untracked research.

## Review focus

1. HTTP 200 SOAP faults / malformed responses must reject, without leaking stream URLs.
2. A late poll from an old track/source must not advance the current queue.
3. Intentional stop/pause must not be treated as natural end; errors must not silently skip songs.
4. A missing/invalid optional transport configuration must fail predictably; absent config uses MPD.
5. Packaged standalone plugins must resolve the shared transport and XML dependency.

## Task 1: SOAP client and shared transport contract

Files: `shared/playback/{index,mpd,album-player,soap}.js`, package manifest and tests.
Interfaces: `createTransport({mpd,sm,service,onError,config})`; `play(url,track,valid)`, `activate()`, `pause()`, `resume()`, `seek(ms)`, `stop()`, `close()`.

- [x] Write/run failing HTTP integration tests for escaped metadata, faults, timeouts and milliseconds.
- [x] Implement client and MPD transport; Album Player transport explicitly stops MPD before opening the renderer, with cancellation checks between network calls.
- [x] Write/run failing polling tests for end exactly once, startup STOPPED, early failure, intentional stop and ownership loss.
- [x] Implement bounded non-overlapping polling and ownership checks.
- [x] Run the shared suite.

## Task 2: Plugin integration and packaging

Files: Qobuz/Yandex `lib/playback.js`, `lib/transport.js`, `index.js`, manifests/lockfiles and package scripts; adapter tests.
Consumes: shared transport contract. Produces: existing service methods using either engine.

- [x] Write/run failing adapter tests for a selected non-MPD transport and stale controls.
- [x] Integrate optional `transport.json`: `{engine:"album_player",controlUrl:"http://127.0.0.1:PORT/..."}`. Missing config selects MPD; invalid explicit selection does not silently fall back.
- [x] Bundle shared source in release archives and add its XML runtime dependency.
- [x] Run both complete Node suites and targeted packaging verification.

## Task 3: Real Pi acceptance and documentation

- [x] Run the actual ARM renderer with null output and hidden sound devices.
- [x] Exercise production transport against the renderer and actual Qobuz resolver; use the installed Volumio state-machine/queue code in an isolated harness first.
- [x] Verify pause/resume, seek, manual next/previous, end-of-track progression, and unchanged primary queue/state.
- [x] Record exact passed and unverified scenarios; stop test processes and remove private temporary URLs.
- [x] Review final diff and verification results. Preserve remaining milestone scope explicitly.

## Ledger

- Baseline Qobuz: 9 Node tests passed after installing existing dependencies.
- Initial Yandex baseline lacked `.venv` and npm dependencies; restoring the documented environment before baseline.
- Ruling: feature branch in place rather than a second checkout; all existing changes are research from this conversation and remain preserved.

- Task 1: complete — shared transport and HTTP regression suite (13 tests).
- Task 2: complete — Qobuz 12 and Yandex 35 Node tests, standalone archive loading, 6 installer tests.
- Task 3: complete — isolated real CoreStateMachine + ARM renderer + Qobuz, 13-track album / 12 automatic transitions via end seeks; no primary state changes.
- Review: launch/pause race and TRANSITIONING timeout fixed with RED→GREEN regressions; focused re-review clean.

- Final live follow-up: slow native Stop exceeds the original 5 s command deadline on rapid previous; reproduce with delayed HTTP acknowledgement, then increase bounded command deadline and restart readiness budget after Play acknowledgement. Fixed with RED→GREEN regressions; final two-track Pi smoke passed all controls and end-of-queue.
