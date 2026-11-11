# Favicon and display plugins — 2026-11-12

User requested compression of their supplied image, use as browser favicon,
installation of Touch Display, Pi Screen Setup and Now Playing, and commit/push/
merge into main before their review. HDMI confirmed; resolution, rotation and
other display configuration explicitly deferred by the user.

## Git and favicon

- Existing Playback Engines implementation committed as `53dbea1`, feature branch
  pushed, fast-forwarded into `main` and pushed before the new UI work.
- Favicon change committed as `d3f1857`, feature branch pushed, fast-forwarded into
  `main` and pushed. No force push.
- Supplied square PNG resized without redrawing to a 64x64 indexed PNG, 4304 bytes.
  ICO fallback contains 16/32/48/64 pixel sizes, 13387 bytes. Original download
  untouched. Removed playback's dynamic SVG substitution so the custom image
  remains the tab icon during playback and pause.
- Versioned icon URLs bypass stale browser favicon caches. Existing home-screen
  icons are unchanged; scope is the browser tab favicon.
- Artwork One rebuilt and packaged; package checksum manifest updated. Only UI
  files deployed, with the previous UI retained on the Pi as `ui-before-favicon`.
- Live browser verified PNG URL, HTTP 200, image/png and exact 4304-byte body.
  Served file hash matches installed and source assets.
- TypeScript/Vite build passed; 13 plugin tests passed, one existing miniunzip
  test skipped; 18 UI helper tests passed. Shared playback tests passed before
  merging the engine changes. Package checksum verification passed.

## Plugin provenance and scope

Official stable store endpoints for Volumio / Bookworm / ARMHF were used:
`https://plugins.volumio.workers.dev/pluginsv2/downloadLatestStable/NAME/volumio/bookworm/armhf`.
The store catalog's Now Playing version label differed from the actual downloaded
package; the version below comes from the installed package manifest.

- [Touch Display](https://github.com/volumio/volumio-plugins-sources-bookworm/tree/master/touch_display): 3.6.0.
  Archive SHA256: `723214c32954e1c38fc40fef5daa21ad37f05a52e501ce668211a62f679f2eb1`.
- [Pi Screen Setup](https://github.com/foonerd/pi_screen_setup): 1.0.0.
  Archive SHA256: `98f72fa931eba314bc6265740ba63e77f27e3230977d67cb57bc4179441d3ba1`.
- [Now Playing](https://github.com/patrickkfkan/volumio-now-playing): 1.0.6.
  Archive SHA256: `e81412e0ae27def956001e7e0f51f42fb89adad173cdd241635886e59b01213e`.

Native Volumio installer used sequentially, with its package scripts. Touch
Display installs X.Org, Chromium, input tools and fonts. No screen mode/preset
was applied and no kiosk was started. The three plugins remain disabled pending
HDMI configuration. Installation alone does not validate physical video or touch.

Boot files, plugin registry and queue backed up on the Pi before installation;
backup is private and is not in Git. No third-party plugin binaries or account
state added to this repository.

## Final verification

All three installed manifests and Volumio's persisted registry agree: Touch
Display 3.6.0, Pi Screen Setup 1.0.0, Now Playing 1.0.6; enabled=false,
status=STOPPED. Kiosk service inactive. Chromium, X.Org, xinput and Openbox
installed. Now Playing's geo-tz dependency loads and returns a timezone. Pi Screen
Setup root-helper sudoers entry validates. Plugin start/display rendering has
intentionally not been tested because HDMI setup was deferred.

`/boot/config.txt`, `/boot/userconfig.txt`, `/boot/volumioconfig.txt` and `/data/queue`
match the pre-install backup byte-for-byte. Pi Screen Setup adds its unconfigured
placeholder `/boot/videoconfig.txt`; no display preset applied. Global ALSA config,
queue SHA256 and native MPD hardware volume 86 match the pre-install snapshot.
Existing Qobuz/Yandex account, API-key and settings files match their saved hashes.
Volumio remains active; playback remains stopped.

## Favicon replacement later on 2026-11-12

User supplied `Minimal Hi‑Fi Audio Player Icon.png` (974154 bytes, 1536x1024).
Trimmed excess white margins and retained the rectangular mark's proportions on
64x64 white canvas. Optimized indexed PNG is 1094 bytes; ICO fallback is 5978
bytes. Original download left intact. Icon URLs now use `v=20261112-hifi`.
TypeScript/Vite build passed. Updated package and checksums. Static UI deployed
without restarting audio, and live HTTP checks confirmed the new HTML icon URL,
image/png response and exact 1094-byte installed file. Previous static UI retained
on Pi as `ui-before-hifi-favicon`.
