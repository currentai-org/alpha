---
bump: minor
summary: Ticker pattern: a single line that fades at its clipped edge instead of an ellipsis and scrolls on hover or keyboard focus, pausing at each end; the lint knows the custom properties utilities.css defines
---

- Favicon pattern: a site's icon at the start of its link, lazy and decorative, falling back to a globe in the same box when there is no src or it fails to load

- Sidebar header, item and thread header controls take localizable accessible labels

- AppShell.Sidebar: resizeTitle and dragOpenTitle props localize the resize handle tooltips

<!-- surface: written by `pnpm ds:change` — rerun it rather than editing by hand -->

```surface
+ export Favicon
+ export Ticker
+ part Favicon
+ part Ticker
+ prop AppShell.Sidebar.closeLabel
+ prop AppShell.Sidebar.dragOpenLabel
+ prop AppShell.Sidebar.dragOpenTitle
+ prop AppShell.Sidebar.resizeLabel
+ prop AppShell.Sidebar.resizeTitle
+ prop Favicon.class
+ prop Favicon.size
+ prop Favicon.src
+ prop Sidebar.Header.closeLabel
+ prop Sidebar.Header.collapseLabel
+ prop Sidebar.Header.expandLabel
+ prop ThreadHeader.openSidebarLabel
+ prop Ticker.class
+ prop Ticker.fade
+ prop Ticker.pause
+ prop Ticker.play
+ prop Ticker.speed
```
