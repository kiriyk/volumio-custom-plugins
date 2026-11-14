# Playback Engines for Volumio 4

Separate `audio_interface/playback_engines` plugin for ARMHF / Bookworm.
Sources Qobuz Custom and Yandex Music need version 0.3.1 or later. Local library
files are supported through a loopback HTTP range server.

Enable the plugin, open its settings, select MPD or Album Player and an ALSA
output, choose each engine's processing mode, then Apply. Opening settings and
connecting a DAC never change output. Switching stops playback and preserves
the queue. Resume playback manually. A removed device remains selected; reconnect
it and Apply to restore readiness. There is no fallback to speakers.

Both engines keep independent custom profiles. “Всё отключено” disables digital
gain and processing and uses a direct `hw:` ALSA output. Hardware gain is never
set by the plugin. Each transition into this mode warns to lower the DAC or
amplifier volume: removing software attenuation can raise the signal level.
Unsupported source PCM formats in this mode stop with an error rather than
silently converting. DSD bypass has not been validated and is rejected.
Settings alone do not establish verified bit-perfect playback.

Custom mode uses explicit processing settings of this plugin; it does not import
Volumio/FusionDsp effects. MPD supports software volume, rate conversion,
normalization, ReplayGain and crossfade. Album Player exposes its own software
volume, sample-rate/precision controls, channel processing and convolution.
DSD output needs compatible hardware and remains unverified on a physical DAC.

## Installation and state

`npm ci && npm test && npm run package`. The archive contains the plugin and shared
transport code. Install using Volumio's plugin installer on the player. `install.sh`
requires root, checks the platform, installs missing system dependencies and
fetches the official pinned renderer archive with SHA256 verification. It never
runs vendor installation scripts or starts the renderer during installation.
The native renderer is proprietary freeware, downloaded separately from
https://albumplayer.ru/linux/ and excluded from this repository/package.

State lives under `/data/configuration/audio_interface/playback_engines/`:
`settings.json`, private `asound.conf`, renderer files/configuration and MPD recovery
backup. Global `/etc/asound.conf` is untouched. Renderer runs as `volumio`, with
ALSA audio group access, in `volumio-playback-renderer.service`; control URLs must
belong to its actual PID. Disable the plugin to regenerate normal Volumio MPD
configuration. Saved profiles survive disable/update/uninstall. The uninstaller
restores the MPD backup only if the plugin's output marker is still present.

## Validation limits

Automated tests cover profile mapping, stable device identity, exact ALSA parameter
negotiation, file containment/ranges, output switching, rollback, volume blocking
and source cancellation. Physical USB DAC hotplug and FiiO BTA30 Pro formats still
require a connected device. Null-output testing establishes control flow only.

Порядок проверки фактического вывода: [VERIFYING-AUDIO.md](VERIFYING-AUDIO.md).

## Version 0.1.1

Album Player keeps its PCM handle after Stop/natural end. In bypass the plugin
now stops the owned renderer before exact-format preflight, then starts it with
the saved profile. This prevents the second-track stall; process startup may add
a pause between tracks. A busy device is reported separately from an unsupported
format. Cancelling a launch after native Play acknowledgement also stops it.

The “Фактический аудиовывод” section and “Проверить тракт” button read ALSA state,
owner PID/process and hardware format. Artwork One distinguishes the selected
engine from a kernel-observed running engine, and exposes mismatches. This is
route/format evidence, not a bit-perfect sample comparison. Without a USB serial
number the saved identity includes the USB port; moving the DAC to another port
requires selecting its available entry again. No automatic fallback is performed.

## Version 0.1.4

Managed local playback no longer exposes native MPD `prefetch()` to Volumio.
The native queue timer otherwise advances the position before Album Player EOF,
invalidating its active track without starting the next one. Both managed
engines now retain queue ownership until the actual EOF notification; disabling
managed playback restores native MPD prefetch. This does not provide gapless
playback.

Local CUE virtual tracks (`album.cue/track0001`) resolve to exact INDEX 01 sample
boundaries in the referenced audio file. The bridge prepares a seekable WAVE
segment using FFmpeg without resampling, channel mixing or gain changes; 16/24/32
bit integer precision is preserved. Preparation adds a pause before a CUE track.
The disk cache is under the plugin state directory on `/data`, with two segments
of at most 256 MiB each. Cancellation/close removes incomplete files; startup
prunes sessions belonging to dead processes. It does not store decoded tracks in
`/tmp` RAM. CUE sheets must be valid UTF-8 with AUDIO tracks and supported FILE
syntax. Separate PREGAP/POSTGAP silence is not synthesized; INDEX 01 defines the
played boundaries. Nonintegral sample boundaries and unsupported formats fail
explicitly. Unmanaged native MPD playback is unchanged.

Artwork One fixes local CUE cover addresses by asking the album-art service for
the album directory, instead of receiving the CUE text as an image.
