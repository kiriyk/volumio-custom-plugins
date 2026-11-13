# Audio settings and provider navigation

## Result

Artwork One renders the existing Playback Engines controller sections in Settings → Аудио when that plugin is enabled. Its plugin settings link redirects there. Section objects, save endpoints, separate engine profiles and bypass warning behavior are retained; no second settings store or migration exists. With the plugin disabled or absent the native Volumio audio page remains available. If an enabled controller cannot answer, the page offers retry instead of presenting conflicting native volume/output controls.

Native output, mixer, playback and resampling forms are replaced as a whole while Playback Engines is enabled. Native I2S setup and MPD buffer/queue options therefore remain available by disabling the plugin. Their saved values are retained. This avoids mixing native configuration writes (including the native mixer change that can set hardware volume to 100%) with managed engine profiles.

Settings search requests the same source as the displayed page, indexes engine sections under Audio and retries when enable state changes during an in-flight request.

Device discovery now names modern HDMI outputs 1/2, legacy bcm2835 HDMI endpoints 1/2 (совместимый), Jack 3,5 мм, and USB product names. Legacy classification uses /proc/asound/cards, since the actual Pi shares bcm2835-audio driver between HDMI and Headphones. Stable keys and PCM addressing are unchanged.

Seven local SVG covers decorate root collection tiles: Qobuz albums/artists/downloads; Yandex liked tracks/playlists/albums/artists. Provider art retains priority, unrelated resources, pagination and download jobs remain unchanged. Artwork is a presentation fallback; provider data is not rewritten.

Russian navigation covers the main menu, browse/queue/Now Playing actions, plugin manager, settings navigation/search, common dialogs and settings chrome. Technical settings labels and external provider metadata retain their original names.

## Verification

- Production TypeScript/Vite build succeeds (existing large-chunk advisory).
- Artwork One helper tests: 28 pass.
- Artwork One plugin tests: 13 pass, one existing miniunzip-dependent skip.
- Playback Engines Node tests: 52 pass; Python device/helper tests: 17 pass.
- Shared playback tests: 18 pass; Qobuz: 12 pass; Yandex: 35 pass.
- Navigation agent reports lint blocked by the pre-existing conditional useLocation in QueuePanel.tsx (same line present in HEAD); production typecheck/build passes.
- Review corrected an in-flight settings-search source change race.
- Browser with real player: Audio shows both profiles, no competing native volume form; Playback Engines link redirects to Audio; search for «Движок» returns Audio section/row.
- Installed browser root pages load all three Qobuz and four Yandex covers with nonzero image dimensions.
- Installed helper reports HDMI выход 1/2, compatible HDMI endpoints, Jack 3,5 мм, FiiO BTA30 PRO.
- Deployment updates static UI and read-only discovery helper without restarting Volumio or starting playback.
- Player settings.json, /etc/asound.conf and /data/queue hashes match before/after deployment. No profile or output selection was applied during verification.

Player backups: /data/plugins/user_interface/artwork_one/ui-before-audio-settings-20261113 and /tmp/audio-settings-20261113-user-backup. The currently remembered FiiO USB port remains unavailable; verification does not silently reselect the DAC at its new USB port.
