# Engine playback repair and actual-output observation

User reported Album Player stalls after its first track, and unclear distinction
between selected engine and actual playback. Continue existing authorized plugin
work in feature branch; preserve accounts, queue, profiles and hardware gain.

Evidence: on the real FiiO BTA30 Pro, silent PCM plays, but exact-format preflight
fails PCM busy after natural end and explicit Stop. Stopping owned renderer process
releases it. Current saved device key refers to USB port 1-1.4, attached device is
now at 1-1.2; do not silently reselect or fall back. Source/transition clarification
was requested asynchronously; continue independently with reproduced failure.

Implementation:
- Release Album Player process before bypass preflight, then configure/restart it.
  Keep ownership/cancellation guards. Distinguish device busy from format rejection.
  This can add a track-boundary pause; no gapless claim.
- Read selected device's ALSA procfs parameters/status/process owner. Expose actual
  engine, PCM rate/format/channels and mismatch/idle/unavailable states. A selected
  profile or ready flag must never count as confirmation of actual running audio.
- Add read-only diagnostic section/check button and honest actual/selected labels
  in Artwork One; never claim measured bit-perfect from this observation.
- TDD on retained PCM, busy classification and actual-output evidence. Verify
  sequential silent playback on hardware and fixtures for mismatched/closed PCM.
- Fresh review, suites, package/deploy preserving saved selection/profile state;
  no unmuted music or queue replacement. Commit/push/main workflow retained.


Completed: retained PCM regression RED→GREEN; 4 natural-end silent hardware tracks
through Manager/AP/FiiO confirmed correct owner/formats. MPD observation also tested
on physical FiiO using an isolated instance; output thread TID resolved to Tgid.
Independent review's format-mismatch-label and incomplete-stream observations fixed
with RED→GREEN tests. Native 0.1.1/static UI installed; saved configuration/queue/
global ALSA preserved. No silent USB port reassignment. Current profile remains
unavailable until user selects FiiO at its current port. Sample equality untested.
