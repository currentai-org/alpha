---
bump: patch
summary: ComposerAccessory panels ease open, shut and across a switch
---

`Panel` eases its height and opacity on the `--ds-duration-slow` and `--ds-ease-standard` tokens, so the composer and the page around it glide instead of snapping, and it swaps instantly under reduced motion. Switching from one panel to another no longer stacks the outgoing panel on the incoming one for the length of a fade, which had pushed the composer out of the window and back. `internal/motion.ts` reads the same tokens for any JS-driven transition.
