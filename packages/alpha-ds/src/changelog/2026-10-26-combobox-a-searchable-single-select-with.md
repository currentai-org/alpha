---
bump: minor
summary: Combobox: a searchable single-select with fuzzyFilter ranking
---

<!-- surface: written by `pnpm ds:change` — rerun it rather than editing by hand -->

```surface
+ export Combobox
+ export fuzzyFilter
+ export fuzzyScore
+ part Combobox.Empty
+ part Combobox.Input
+ part Combobox.Item
+ part Combobox.Popup
+ part Combobox.Positioner
+ part Combobox.Root
+ part Combobox.Separator
+ prop Combobox.Input.placeholder
+ prop Combobox.Input.triggerLabel
+ prop Combobox.Item.label
+ prop Combobox.Item.value
+ prop Combobox.Root.inputValue
+ prop Combobox.Root.items
+ prop Combobox.Root.name / required / disabled
+ prop Combobox.Root.open
+ prop Combobox.Root.value
+ type FuzzyItem
```
