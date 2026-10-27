// The FALLBACK for the read-aloud (TTS) feature switch — no longer the switch itself.
//
// Since CUR-225 the operative gate is `readAloudEnabled()` in server/readAloudGate.ts, a PostHog flag
// that falls back to this const. Editing this value still changes behaviour, but only where PostHog
// has not defined the key; the flag wins when it has. Do not treat a `true` here as "the feature is
// on" without checking the flag, and do not add a third switch — the whole point of that ticket was
// that there were two.
//
// This const stays because it must be importable from BOTH the server generation path and client
// components, and flags.ts is server-only. Its value is the no-PostHog default, which is off.
//
// The composer toggle reads this same gate: its `hidden` class in ChatInput.svelte is not a
// separate off switch.
//
// "Off by default" is not silent unless the server enforces it. Two paths would still produce audio —
// the server's absent-speakMode fallback resolves to "auto" (see resolveSpeakMode in server/speak.ts),
// and any browser that set auto/always while the toggle was visible keeps sending that preference
// with no UI left to turn it back off. Forcing the effective mode to "off" on the server neutralizes
// both: with no clip produced, the stale client preference and the autoplay path go inert.
//
// Plain const (not an env flag) so the state is explicit in git and a redeploy isn't needed to
// read it; imported by both the server generation path and the client components.
export const READ_ALOUD_ENABLED = false;
