# CUE playback, album art and Album Player queue repair

## Observed failures

The Pi had approximately 2.9–3.0 GiB available RAM and no recorded OOM kills. The
external drive was mounted and an ordinary local FLAC decoded successfully.
Qobuz and Yandex resolution/probing also succeeded (16/44.1 and 24/44.1 stereo).

Local CUE tracks exposed virtual paths ending in `.cue/track0001`. The bridge
attempted filesystem realpath on that virtual path and failed with ENOTDIR.
Native album-art endpoints with a CUE-file path returned the raw CUE file:
200 application/octet-stream, 1,898 bytes. Asking for its directory returned the
actual JPEG: 200 image/jpeg, 160,714 bytes.

After CUE playback was restored, the user reported each Album Player track
stopping without continuation. The real Volumio 4.239 queue timer discovers the
native MPD prefetch method, sets prefetchDone, and advances its queue position
about 500 ms before the renderer EOF. The adapter then loses ownership of its
track and closes polling. The next track remains unstarted. This is independent
of the previously fixed native renderer retaining its ALSA handle after Stop.

## Changes

- Resolve CUE FILE/INDEX 01 safely, convert exact sample segments to a private
  seekable WAVE, preserve integer PCM precision/rate/channels, keep format
  preflight and all existing engine/profile handling.
- Cache on `/data`, two files, 256 MiB each; stop old audio before preparation,
  cancel stale work, clean incomplete/dead-process sessions, retain HTTP ranges.
- Preserve original queue URI in WAVE metadata. Hidden/cancelled preparation
  cannot stop a newer track.
- Correct local CUE album-art directory requests in Artwork One.
- Hide native MPD prefetch dynamically only while playback is managed. Restore
  its original descriptor/prototype behavior on close or unmanaged operation.

## Evidence

- Before/after tests on the Pi: 16/24/32-bit sample-for-sample segment equality;
  24-bit FLAC at 44.1/96 kHz with nonzero seek anchors; URI Unicode/percent paths,
  HTTP HEAD/Range, cancellation, eviction, root containment and stale cache cleanup.
- Actual Adele 30 first track: prepared in 4,061 ms, 44,100 Hz, 16-bit stereo,
  exactly 8,033,256 samples / 182.160 seconds, matching the next CUE INDEX 01.
- Real installed Volumio Core play/syncState/increasePlaybackTimer loaded in an
  isolated VM; real manager and SOAP transport; simulated renderer responses.
  Native-prefetch negative control reproduces premature queue advancement.
  Fixed MPD/Qobuz/Yandex each launch three consecutive tracks exactly once after
  actual EOF, preserve bypass preflight, and stop at queue end.
- Tests use a fake MPD config writer with explicitly advancing mtime: Pi tmpfs
  assigned identical mtimes to 20/20 immediate synchronous rewrites, making the
  former test fixture nondeterministic. No production timestamp policy changed.
- Physical FiiO was absent on November 14. No HDMI fallback or volume changes
  were made; queue tests do not establish audible output or bit-perfectness.

The 0.1.3 package installed during the previous session included the CUE fixes;
0.1.4 includes those changes plus the native-prefetch queue repair. CUE segment
preparation and native renderer startup still introduce gaps between tracks.

## Installed verification and release

- Entire Playback Engines Node suite on Pi: **76 passed, 0 failed, 0 skipped**
  (including real FFmpeg and installed Volumio Core checks). Test output:
  `/tmp/playback-verify-20261114/final-result.txt`.
- Shared transport: 19 passed; Artwork One helpers: 37 passed; Python helpers:
  17 passed; Qobuz: 12 passed; Yandex: 35 passed; production UI build passed.
- Installed Playback Engines 0.1.4 and UI `cue-queue-fix-20261114`; core API responds
  and remains stopped. Settings/queue/global ALSA hashes match before/after.
- Browser against installed UI loads Adele CUE covers as actual images (30:
  1417 px wide; 19: 1792 px), requesting directories rather than CUE files.
- Read-only final review reported no remaining blockers.
- Persistent rollback backup: `/data/engine-update-backups/20261114-queue`;
  old UI: `/data/plugins/user_interface/artwork_one/ui-before-queue-fix-20261114`.
- Selected FiiO USB key remained unchanged while the DAC was physically absent.
  No substitute output was selected and audible playback was not verified on
  November 14.
