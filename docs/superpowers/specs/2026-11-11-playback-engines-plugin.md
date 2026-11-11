# Playback Engines plugin — agreed design

User approved a separate Volumio plugin controlling MPD / Album Player, two
processing profiles per engine, and USB DAC discovery. Existing sources remain
separate. Implement and install while preserving queue/accounts. Opening settings
must not change output or raise volume. Device appearance updates the list but
does not select a newly plugged device automatically; remember the chosen device.

## Product behavior

- Settings: engine, per-engine bypass/custom mode, selected device, custom settings,
  current readiness/error. Native Volumio plugin UI; Artwork One reflects actual engine.
- Both modes of MPD use the existing MPD daemon/binary and library. Its generated
  ALSA output is adapted while managed. Bypass uses hw directly, no digital gain,
  normalization, ReplayGain, forced format, filters or crossfade. Custom parameters
  are explicit settings of this plugin (resampling, software gain, normalization,
  ReplayGain, crossfade), seeded from current playback settings when available.
- MPD custom settings and Album Player custom settings persist independently.
- Album Player renderer runs as volumio in its own systemd unit and private working
  directory. ALSA_CONFIG_PATH selects a private default hw PCM; global asound.conf
  is not changed. Determine controlURL only from the owned service process.
- All source transports resolve the manager at play time. Local MPD queue playback
  uses the renderer via a loopback file/range bridge when Album Player is selected.
- Stop before switching, preserve queue/current index; no auto-resume or fallback
  to speakers. On failure report error and roll back config/service if possible.
- USB discovery uses ALSA cards plus sysfs identity, never persist card numbers.
- Bypass preflights exact PCM rate/channels/bit precision via libasound hw_params
  against the selected hardware. Unsupported/unknown formats (including unverified
  DSD bypass) fail rather than silently convert. Packing 24-bit into 32 is allowed.
- Do not raise hardware volume. Plugin-managed volume uses software gain only when
  explicitly enabled in custom mode; native volume requests are blocked in bypass.
- No claimed bit-perfect verification from flags or matched rates alone.

## Components and contracts

New plugin directory `playback-engines`, name `playback_engines`, category `audio_interface`.

Python CLI `service/devices.py` (standard library + system libasound):
`devices` -> JSON array of `{key,label,pcm,index,device,usb}`;
`check PCM RATE BITS CHANNELS` -> `{supported:true}` or nonzero JSON error;
`discover PID` -> `{controlUrl,renderingControlUrl}` for ap2renderer socket owner.
No writes, subprocess shell, audio samples, or privilege escalation in this helper.

JS `lib/profiles.js` exports defaults(), validateSettings(value), effectiveProfile(settings),
albumPatch(mode,custom), albumPayload(current,patch), rewriteMpdConfig(text,pcm,mode,custom).
Schema: `{version:1,managed:false,engine:'mpd',device:null|{key,label},
modes:{mpd:'custom',album_player:'bypass'},custom:{mpd:{volumeEnabled:false,volume:80,
resampleRate:0,resampleBits:24,normalization:false,replaygain:'off',crossfade:0},
album_player:{volumeEnabled:false,volume:80,resampleRate:0,forceBits:0,phaseInvert:false,
swapChannels:false,downmix:false,convolverEnabled:false,convolverFilter:0,
convolverGain:0,dsdMode:0}}}`. Return fresh objects and preserve inactive profile.

JS `lib/local-stream.js`: class LocalStream({roots=['/mnt/USB','/mnt/NAS','/mnt/INTERNAL'],port=0}).
Methods async start(), async urlFor(uri), async close(). Resolve only regular files
under permitted real roots, support stable Volumio `music-library/USB/...`, `USB/...`,
`/mnt/USB/...` and absolute permitted paths. No traversal/symlink escapes. Loopback
HTTP GET/HEAD, ranges, opaque tickets, MIME. Reject unsupported cue/protocol URIs.

Manager owns systemd lifecycle, current selected transport, safe transitions, hooks
into MPD/volume, shared settings, preflight and polling status. Controller builds
native UI and serializes saves. Existing transports remain usable when plugin absent.

## Validation

TDD for settings/profile preservation, MPD configuration generation, device identity,
local file ranges, safe switching/rollback, unavailable output, stale requests and UI
read-only behavior. Run all affected suites, independent review and package checks.
On Pi test actual UI/save flow, service restarts, profiles and sources. Keep real DAC
and FiiO validation explicit if device absent; don't substitute null for hardware proof.
