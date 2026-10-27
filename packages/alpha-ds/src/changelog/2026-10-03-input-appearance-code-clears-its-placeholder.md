---
bump: patch
summary: Input appearance=code clears its placeholder while focused
---

An empty, focused, centred field puts the caret in the middle of its placeholder, so the sign-in
code field read "000|000" (CUR-2660). The recipe adds `focus:placeholder:text-transparent` to
`appearance: code`; the placeholder still shows on a blurred field. The Input catalog example now
includes a code field.
