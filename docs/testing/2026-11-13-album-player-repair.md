# Album Player first-track stall / actual output — 2026-11-13

User observed that switching worked but Album Player could not start anything
after the first track, and selection labels did not establish actual playback.

## Root cause, measured on FiiO BTA30 Pro

Short 16-bit 44.1-kHz WAV containing digital zeros was served over loopback HTTP.
The user-facing player was stopped, renderer service initially inactive. No
hardware gain, user queue or saved engine settings were changed.

| Probe point | Exact-format ALSA preflight |
| --- | --- |
| Before renderer playback | succeeds |
| After natural end | PCM busy |
| After explicit AVTransport Stop | PCM busy |
| After stopping owned renderer process | succeeds |

Native renderer retained an open MMAP_INTERLEAVED/S32_LE/stereo/44100 PCM after
Stop. Manager attempted exclusive snd_pcm_open for every bypass track, retried for
three seconds and incorrectly converted the busy condition into UNSUPPORTED_FORMAT.

Fix: stop the owned renderer process before bypass capability preflight, then
start/configure it for the next track. Guards still cancel stale launches. Native
PCM busy maps to DEVICE_BUSY separately from unsupported PCM. Preflight errors
appear in plugin state and successful launches clear previous errors. A cancelled
launch that already received native Play acknowledgement now stops its delegate
before releasing manager ownership. This introduces process startup at bypass
track boundaries; gapless playback is not claimed.

## Actual-output evidence

New read-only observation of selected card ID/device, open PCM hw_params/status,
owner PID and process. Ready/configured and selected engine are separate from
confirmed running PCM. Closed, unknown, missing and mismatched output are explicit.
Unknown/unreadable substreams cannot produce a positive confirmation. Source PCM
rate/channels/precision comparison flags bypass changes; 24-bit in a 32-bit integer
container is allowed. The native settings page has “Фактический аудиовывод” /
“Проверить тракт”. Artwork One now displays selected/unconfirmed versus ALSA-owned
engine and reports mismatches even when the owning process matches selection.
No claim of independently verified PCM sample equality is added.

## Tests and hardware acceptance

Regression with real HTTP mock SOAP reproduced retained-PCM second-track failure
before fix. Additional regressions cover native launch cancellation, busy error
classification, error recovery, unknown owners, reused card IDs, unreadable streams,
format mismatch and selected-versus-actual UI labels. Whole-change independent
read-only review found the same-owner format-label issue and unreadable-substream
uncertainty issue; both reproduced RED and fixed GREEN.

Real hardware ran four sequential silent WAV tracks through repaired Manager,
real renderer, owned SOAP endpoints and FiiO. Every track ended naturally, next
launch succeeded, kernel owner was ap2renderer and source/ALSA formats matched:

| Input | Actual PCM | Result |
| --- | --- | --- |
| 16-bit / 44100 | S32_LE / 44100 / stereo | natural end, next launch works |
| 24-bit / 96000 | S32_LE / 96000 / stereo | natural end, next launch works |
| 16-bit / 44100 | S32_LE / 44100 / stereo | natural end, next launch works |
| 16-bit / 48000 | S32_LE / 48000 / stereo | natural end |

Final code repeated this hardware test successfully. Test queue/state machine was
isolated from the user's queue; actual account streaming and main Core automatic
queue navigation were not re-exercised by this silent test. Earlier source tests
and shared transport tests remain green. No audible quality/sample-equality test.

An additional isolated instance of the installed MPD binary played digital zeros
through the same FiiO. Hardware PCM was S16_LE / 44100 / stereo; observation
confirmed MPD. ALSA reported the MPD output thread TID (`output:...`), so observation
now resolves `/proc/TID/status` Tgid to the owning process before identifying it.
This behavior was reproduced and covered by a failing-then-passing regression.
No user-facing MPD queue or settings were changed by this private-instance test.

Automated: 52 plugin Node tests, 18 shared, 12 Qobuz, 35 Yandex, 14 Python; Artwork
13 plugin tests pass (one existing miniunzip skip), 21 helper tests pass, TS/Vite
build passes with existing large-chunk advisory.

## Deployment and selected device

Version 0.1.1 code/static UI deployed on Pi, main Volumio restarted while stopped.
Pre-update code/settings/queue/ALSA backup kept privately on the Pi. Saved settings,
user queue and global ALSA configuration remain byte-for-byte unchanged.

Current saved FiiO key ends in USB path 1-1.4 while the available FiiO is at 1-1.2.
It has no exposed USB serial in this identity. The new diagnostic correctly reports
DEVICE_UNAVAILABLE / no confirmed engine. The selected output was not silently
rebound to another port. User needs to choose the available FiiO and Apply.
Systemd renderer is inactive at end; no autoplay, profile reset or hardware gain
changes. Host now resolves as volumio.local / 192.168.3.150.
