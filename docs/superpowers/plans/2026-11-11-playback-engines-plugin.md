# Playback Engines plugin implementation plan

User approved the separate-plugin approach and requested implementation.
Spec: `docs/superpowers/specs/2026-11-11-playback-engines-plugin.md`.
Execution: independent device/profile/file-bridge modules in parallel; manager,
controller, deployment and integration inline. Current feature branch retained.

- [x] Device discovery, stable keys, exact PCM capability preflight and owned renderer discovery.
- [x] Independent profile validation/mapping and MPD config generation without volume changes.
- [x] Loopback local-file bridge supporting ranges and containment.
- [x] Manager: lifecycle, safe save/rollback, MPD/volume hooks, local playback and source transport selection.
- [x] Native plugin UI with live device list, modes, per-engine custom settings and explicit errors.
- [x] Systemd/install/package/update/uninstall, pinned renderer acquisition, preserved account state.
- [x] Qobuz/Yandex integration and Artwork One actual-engine indication.
- [x] Unit/integration suites, review, isolated and installed Pi verification, documentation and commit.

Review focus: no activation on viewing settings; no automatic 100% gain; no wrong
renderer control; no queue loss; no fallback to speakers; stop before reconfigure;
no stale-source commands; no contradictory success on partial save.

Ledger:
- Existing transport baseline committed as 9d8bcca, working tree clean at start.
- Observed native Volumio volume-option setters can set hardware volume to 100;
  manager will not use those setters for bypass and will own managed volume routing.
- Continued 2026-11-11: modules, manager, native UI, packaging and source/UI integration implemented.
- Independent whole-change review found delayed local launch after Stop, mute defeated by next track,
  and disable/save race. Each reproduced RED and fixed GREEN with regression tests.
- Added startup missing-DAC fencing, renderer profile reapplication, disabled-state indication,
  and late-enabled manager resolution at source play time.
- Ruling: retain the existing feature branch and uncommitted prior-stage work instead of creating
  a second worktree — this is continuation of the same authorized implementation.
- Minor deferred: custom profiles start with explicit neutral defaults rather than importing
  existing Volumio DSP settings. UI/docs state this; copying a partial native chain could misrepresent it.
- Review runtime exclusions are validation limits: physical USB/FiiO, actual sample equality,
  DSD and gapless audio cannot be established without hardware. Pi control/routing is tested separately.

- Installed acceptance complete: profiles, warning repetition, Qobuz controls, local FLAC
  and Yandex through both engines on real Headphones at zero software volume; queue,
  account state and global ALSA hashes retained. Details: docs/testing/2026-11-11-playback-engines.md.
- Native runtime regressions (early MPD callback, mnt/USB URI) reproduced RED, fixed GREEN,
  retested on the Pi. Final plugin state enabled/unmanaged/no device; renderer stopped.
- Ruling: retain the feature branch without merge/push; installation is the authorized
  deliverable. Runtime exclusions remain explicit hardware/measurement limits, not claims.
