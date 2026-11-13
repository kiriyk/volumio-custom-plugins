# Simplified Audio controls

- Main output selector contains modern HDMI 1/2, Jack and connected USB products. Old bcm2835 endpoints are expandable via «Дополнительные выходы». Currently selected legacy endpoint remains visible to avoid misrepresenting saved state.
- Missing remembered output is a status plus a disabled selection placeholder; its stable saved key remains intact until an explicit Apply. No fallback device is selected automatically.
- Only the draft engine's mode is shown. Its custom profile card appears only in custom mode. Hidden controller fields retain their original values/save endpoints.
- Settings search uses the same visibility rules. While Audio is open it projects its current draft; after navigation it projects a saved configuration snapshot. Repeated installed-plugin metadata pushes preserve draft references when controller enable state did not change.

## Driver clarification

«Совместимый» was an inaccurate presentation label. The Pi exposes a legacy firmware bcm2835 HDMI card and modern vc4 HDMI cards. /proc/asound/card0/pcm{0,1}p/info both report bcm2835 HDMI 1. Raspberry Pi kernel rpi-6.12.y bcm2835.c bcm2835_audio_dual_newpcm creates both normal PCM and an SPDIF-mode PCM with the same route. Thus old endpoints 0/1 are driver variants, not evidence of separate physical ports. They are now displayed as «HDMI, старый драйвер (вариант N)» in the optional list. Neither their presence nor their name guarantees compatibility with current KMS.

Primary source: https://github.com/raspberrypi/linux/blob/rpi-6.12.y/drivers/staging/vc04_services/bcm2835-audio/bcm2835.c

## Verification

- Production TypeScript/Vite build passes; existing chunk-size advisory remains.
- UI helper suite: 32 pass, including 4 new audio presentation regressions.
- Artwork One plugin suite: 13 pass, 1 existing miniunzip-dependent skip.
- Review caught and resolved hidden-target search and retained-draft-after-navigation issues.
- Browser on dev UI with real player: advanced expansion/collapse, engine/mode draft switches, placeholder disabled, legacy selected retention (unit), search Convolver 3 hits for Album Player/custom and 0 after navigating away to saved configuration.
- Installed UI: four main outputs, exactly one mode row, no custom profile in bypass; advanced link present.
- Static UI deployed without restarting Volumio or applying audio settings. settings.json, /etc/asound.conf and queue hashes unchanged across installation.
- Backup UI: /data/plugins/user_interface/artwork_one/ui-before-simplified-audio-20261113.
