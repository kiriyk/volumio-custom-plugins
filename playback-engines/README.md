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
