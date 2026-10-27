---
bump: minor
summary: Tabs gains a segment variant: a segmented control for a few peer views, first used by the storage location tabs (CUR-4363)
---

<!-- surface: written by `pnpm ds:change` — rerun it rather than editing by hand -->

```surface
+ prop Tabs.Root.variant
+ variant tabs.tabsListRecipe.variant=line
+ variant tabs.tabsListRecipe.variant=segment
+ variant tabs.tabsTabRecipe.variant=line
+ variant tabs.tabsTabRecipe.variant=segment
```
