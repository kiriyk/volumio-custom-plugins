# Simplify audio controls

Approved scope: main selector shows modern HDMI/Jack/USB. Legacy bcm2835 outputs appear under an optional expansion and are named old driver. A currently selected legacy output remains visible. Missing remembered device is a status/placeholder, never a silently changed selection. Show only selected engine mode and only its custom profile in custom mode. Edits and hidden values keep original controller objects and save endpoints; switching drafts never applies sound or changes volume.

1. Test pure presentation helper against engine/mode draft transitions, legacy expansion, unavailable selection and preserved stable option keys.
2. Add renderer-only select overrides to SettingsCard; wire helper to PluginPage, filter modes/custom cards from current draft, add local advanced-output button and missing-output hint.
3. Run helper/plugin tests and production build; browser check against player without saving. Review, package/deploy UI only with before/after state hashes, commit/push/merge main.
