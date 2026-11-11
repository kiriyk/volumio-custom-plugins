# Playback Engines 0.1.0 — verification 2026-11-11

Implemented and installed on Raspberry Pi 4, Volumio 4.239 / Bookworm ARMHF.
Qobuz Custom and Yandex Music updated to 0.3.1; Artwork One UI rebuilt/installed.

## Installed checks

- Native Socket.IO UI/save flow: MPD bypass/custom, Album Player bypass/custom,
  and MPD bypass again all reach ready state. Renderer runs as its own systemd
  service, starts/stops correctly, and returns saved processing flags on readback.
- Opening settings does not change MPD config or global ALSA config.
- Three entries into bypass produced exactly three warning notifications.
- Browser verified the settings form, output list and independent profile sections.
- Current Qobuz queue played through MPD and Album Player: play, pause, resume,
  stop. Both used Headphones, S16_LE / 48000 Hz, software volume 0 for silent testing.
- Appended one real local FLAC and one Yandex liked track temporarily. Both played
  through both engines. Local-file bridge supports Volumio's actual `mnt/USB/...`
  queue URI. Test items were removed; original queue contents and index 0 restored.
- Actual ALSA `/proc/asound/card1/pcm0p/sub0/hw_params` confirmed selected hardware
  and negotiated format; this establishes routing, not bit-perfect sample equality.
- Both provider account APIs still report authenticated; existing account files,
  API keys and settings match pre-update SHA256 hashes.
- Volumio queue SHA256 before/after:
  `569a71ac7f60dad735854a7c34d4458b268d925e034eb855d76c062e77310aa2` (26 tracks).
- Global `/etc/asound.conf` SHA256 before/after:
  `1aaffa330cef8ab42a21c0c67300d14a097e066eda1c85482ecc45bf8c83650a`.
- Native hardware-mixer MPD volume reads 86 before and after. Switching and tests
  stop playback; MPD's temporary one-item transport queue is cleared by daemon
  restarts, while the user-facing Volumio queue remains intact.

## Regressions found and fixed

- In-flight local preparation could restart playback after Stop/pause.
- Next MPD track could defeat software mute while the UI still reported mute.
- Disable could return before an in-flight save restarted the renderer.
- Native MPD `createMPDFile` calls back before its asynchronous file write. Wrapper
  now waits for an actual mtime change and stable nonempty file before rewriting
  and restarting, including when returning to native Volumio configuration.
- Local bridge missed native `mnt/USB/...` without a leading slash.
- Sources now resolve a late-enabled/recreated manager on each Play.
- Disabled plugin reports unmanaged state, refuses saves and cannot be implicitly
  enabled by a source. Software volume changes update core state without hardware
  mixer commands. Renderer profile and muted gain are reapplied on every launch.

## Automated validation

- Playback Engines: 41 Node tests; devices/installer: 14 Python tests.
- Shared transports/integration: 18 Node tests.
- Qobuz: 12 Node tests; Yandex: 35 Node tests.
- Artwork One: 13 plugin tests pass, one existing miniunzip-dependent test skipped
  on this development host; 18 helper tests pass. TypeScript/Vite build passes
  with the existing large-chunk advisory. Browser MusicBrainz requests can time
  out independently of playback/settings.
- Package creation, archive exclusions, shell syntax and git whitespace checked.
- Independent review: three important findings reproduced and fixed by failing
  regression tests, then verified green. Manifest architecture and disabled-state
  indication findings also corrected.

## Final device state and limits

Plugin enabled, managed output inactive, no selected device, independent profiles
reset to documented neutral defaults. Native Volumio output restored, playback
stopped, renderer inactive. User chooses output/profile and presses Apply.

USB DAC/FiiO BTA30 Pro was absent. Physical USB hotplug, FiiO format support, DSD,
gapless timing, audible quality and PCM sample equality remain unverified. Automated
fixtures cover stable USB identity and removal behavior. Custom profiles begin
with explicit plugin defaults; importing existing Volumio/FusionDsp settings is
still deferred. There is no verified bit-perfect badge for plugin-managed playback.
