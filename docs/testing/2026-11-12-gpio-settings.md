# GPIO settings route fix — 2026-11-12

Reported: Artwork One showed the GPIO Buttons header and enabled switch but no
button settings, while native API returned six sections with seven fields each.

Root cause: PluginPage normalizes `system_hardware-gpio-buttons` to
`system_hardware/gpio-buttons`, then askUiConfig normalized it again into
`system_hardware/gpio/buttons`. Volumio interprets the third path component as a
core section and returns `{coreSection:"buttons"}`. Artwork One has no such core
section and displayed no cards. Physical buttons are unrelated to this bug.

Fix: one shared pageKey helper leaves slash-based endpoints unchanged and only
converts the first category separator of dash-based routes. Regression reproduced
with the old transformation, fixed and passed; also checks existing underscore
plugin names and three-component core routes.

Validation: TypeScript/Vite build passes, 13 plugin tests pass (one existing
miniunzip-dependent test skipped), 19 helper tests pass, 18 shared tests pass.
Deployed only static UI files on the Pi, no audio restart. Live browser displayed
Button 1–6; enabling Button 1 as an unsaved draft revealed GPIO Pin and Action.
No GPIO settings saved, no physical GPIO listeners reconfigured by the test.

Read-only audio inspection at the same time: Album Player selected in bypass,
Headphones selected, ready=true, software volume control disabled. Owned renderer
PID's GetConfig returned disabled software/hardware volume, forced bit depths,
channel processing and convolver, with all res* fields zero. Private ALSA default
was direct hw Headphones device 0; all MPD outputs disabled. All PCM hw_params
were closed because playback was stopped, so active format/sample equality was
not established. No playback started or volume changed for this inspection.

User guide: [Verifying audio](../../playback-engines/VERIFYING-AUDIO.md).
