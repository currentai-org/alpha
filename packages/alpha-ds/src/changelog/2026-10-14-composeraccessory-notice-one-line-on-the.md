---
bump: minor
summary: ComposerAccessory.Notice: one line on the composer's top edge for a refused file or a photo the chosen model won't read
---

- Toast: corner position (bottom right on desktop, top on phones), stack of 3, timers hold on hover/focus, Escape and close run onDismiss; testId option

- Attachment pattern: photo thumbnails and file cards in one row, inside the composer and above a sent message

- Select.Popup: a long list fades at the edge that has more to scroll to

<!-- surface: written by `pnpm ds:change` — rerun it rather than editing by hand -->

```surface
+ export Attachment
+ export attachmentCardRecipe
+ export attachmentRowRecipe
+ export noticeRecipe
+ part Attachment.Card
+ part Attachment.Row
+ part ComposerAccessory.Notice
+ prop Attachment.Card.busy
+ prop Attachment.Card.busyLabel
+ prop Attachment.Card.class
+ prop Attachment.Card.icon
+ prop Attachment.Card.imageSrc
+ prop Attachment.Card.kind
+ prop Attachment.Card.name
+ prop Attachment.Card.onopen
+ prop Attachment.Card.onremove
+ prop Attachment.Card.openLabel
+ prop Attachment.Card.removeLabel
+ prop Attachment.Row.aria-label
+ prop Attachment.Row.class
+ prop ComposerAccessory.Notice.action
+ prop ComposerAccessory.Notice.dismissLabel
+ prop ComposerAccessory.Notice.icon
+ prop ComposerAccessory.Notice.ondismiss
+ prop Toast.Viewport.max
```
