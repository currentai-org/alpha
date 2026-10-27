---
bump: minor
summary: xray-sweep is easier to notice: a brighter band every 4.5s (was a faint one every 6s), and the pill's hairline flares as it passes, except while the pill is open.
---

- New lint rule alpha-ds/pill-nested-radius: a Button (or native button/link) inside a rounded-pill container must be pill-shaped; it autofixes to shape="pill".

- route-notice: a one-shot accent sweep and hairline flare on a pill, played by the model picker when Auto's read of the draft changes

<!-- surface: written by `pnpm ds:change` — rerun it rather than editing by hand -->

```surface
+ rule alpha-ds/pill-nested-radius
+ utility route-notice
```
