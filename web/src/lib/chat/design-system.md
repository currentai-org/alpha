# Alpha design specification

These rules apply to every new or updated Alpha feature in the chat window. Some existing
components don't match every rule yet. Build new code to the spec. The implementation is the design
system in `packages/alpha-ds/`, whose README covers tokens and components.

Refer to tokens by their spec names (Background 1/2/3, Text 1/2/3, Border 1/2/3, Accent 1/2). Don't
hardcode hex values, and don't treat the codebase's CSS variable names as the spec's names.

## Tokens

### Backgrounds

Darker surfaces sink and lighter surfaces float.

| Token | Value | Role |
|---|---|---|
| **Background 1** | `#181818` | The main app background: chat area, nav, rail, and everything that isn't Background 2 or 3. |
| **Background 2** | `#121212` | Darker. Content inset into the page: cards, widgets, the message-input bar. |
| **Background 3** | `#2F2F2F` | Lighter. Content that floats above the page: the X-ray side panel. |

Choose the tier by whether the element sits in the page or floats above it, and add no fourth
tone. Separate elements on the same tier with a border or an ink tint. Inset widgets such as the
message-input bar always use the Background 2 token.

### Borders

All borders are white. The opacity depends on the surface behind the border.

| Token | Value | Role |
|---|---|---|
| **Border 1** | White @ 10% | Outlines on chat reply and message boxes. |
| **Border 2** | White @ 30% | The default: layout lines, boxes, cards. |
| **Border 3** | White @ 50% | Borders on Background 3, such as X-ray cards, where a lighter fill needs more contrast. |

### Text

| Token | Value | Role |
|---|---|---|
| **Text 1** | white, ~100% | Primary text and icons. |
| **Text 2** | white, ~75% | Supporting copy. |
| **Text 3** | white, ~50% | The least important text. |

Text 2 and Text 3 are Text 1 at lower strength. Don't add grey or tinted text colours.

Text 3 at 50% white on Background 1 sits at the WCAG AA contrast threshold for body text. Where Text
3 holds reading content, such as the empty-state description, raise the opacity. Keep 50% for
decorative and least-important labels.

### Accents

| Token | Value | Role |
|---|---|---|
| **Accent 1** | ≈ `#F88476` | Primary actions (send, X-ray close, footprint icons). |
| **Accent 2** | ≈ `#EA3729` | Destructive actions only ("Forget everything"). A separate colour from Accent 1. |

Never use an accent as a background fill for a card, panel or section. Accents appear in four
places:

- **Icon colour.** Choose the colour by the action's role:
  1. Destructive or irreversible (delete, reset, permanent removal): **Accent 2**. Expect one or two
     such icons in a view at most.
  2. The single primary action in the current context (send, confirm, the one highlighted call to
     action): **Accent 1**.
  3. Anything else: **Text 1**. Most icons fall here.

  The trash can on "Forget everything" is destructive, so it uses Accent 2. The footprint icons and
  the X-ray close button are each their screen's primary action, so they use Accent 1. Colour a new
  icon by applying the same rules, not by matching a similar icon.
- **A line or border.** The X-ray card has an Accent 1 left-edge rule and outer border in place of
  Border 2, to mark it as active. This applies to that component only.
- **A small tag or badge fill.** For example, the "···" marker chip on an X-ray card. If the element
  grows to card size, switch to a Background tone with an accent icon or border. Content inside an
  accent fill is Text 1. The stat-chip glyphs (see [Iconography](#iconography)) are the only
  exception.
- **A small control's fill.** The circular send button and the square X-ray close button. Use an
  accent fill only at icon-button size, never for a container, card or panel.

To decide, compare the element's size to an icon or badge and to a surface people read content on.
At icon or badge size, an accent is fine. At surface size, use a Background tone and put the accent
on the border or icon.

For a new component, use the accent on the icon only. A new destructive button such as "Delete
account" looks like "Forget everything": a Border 2 outline, a Text 1 label, and only the icon
filled with Accent 2. Don't put the accent on the button's border or text.

### Fonts

| Typeface | Token | Use for |
|---|---|---|
| **Plus Jakarta Sans** | Font 1 | The default: body, descriptions, components. |
| **DM Mono** | Font 2 | Technical and meta text only: uppercase tracked labels, tags, panel titles, CTA buttons. Never conversational copy. |
| **Noto Serif** | Font 3 | The onboarding modal headline only. |

## Colour rules

- Hover and active states move text and icons toward full white (Text 1). Bordered and ghost
  buttons also get an ink-tint background. Filled accent buttons drop their fill's opacity instead.
  There is no separate hover colour token.
- Nav and utility icons get a white ink-tint tile on hover (15%) and when active or selected (30%).
  See [Iconography](#iconography).
- Every interactive control shows a `2px` focus-visible ring. Check the ring colour in DevTools
  before you hardcode one.

## Typography

### Size scale

The scale has six steps. If a design needs a size between two steps, round to the nearer one.

| Token | Size | Role |
|---|---|---|
| **Size 1** | 10px | Micro: meta labels, the smallest text. |
| **Size 2** | 12px | Small: captions, helper labels, small button text. |
| **Size 3** | 14px | Body: the default reading size. |
| **Size 4** | 16px | Subhead: bold emphasis above body. |
| **Size 5** | 20px | Heading: inline section headings. |
| **Size 6** | 28–34px | Display: the onboarding headline only. |

### Usage

| Context | Font | Size | Weight / tracking |
|---|---|---|---|
| Top-bar version tag, "OPEN, PUBLIC, NON PROFIT" | Font 2 | Size 1 | Medium, 0.5px, uppercase |
| Onboarding CTA buttons | Font 2 | Size 2 | Uppercase, 0.08em |
| "Prompt examples:" label | Font 1 | Size 2 | Text 3 |
| Prompt-example text | Font 1 | Size 2 | Text 3, Text 1 on hover |
| Empty-state description | Font 1 | Size 2 | Text 3, 22px line height |
| Onboarding body copy | Font 1 | Size 3 | 85% ink opacity |
| X-ray panel title | Font 2 | Size 3 | Medium, 0.7px, uppercase, 30px line height |
| Nav items | Font 2 | Size 3 | Medium, 0.7px, uppercase, 30px line height |
| X-ray card title | Font 1 | Size 4 | Bold, 24px line height |
| Empty-state heading (inline) | Font 2 | Size 5 | Medium, -0.6px tracking |
| Onboarding headline | Font 3 | Size 6 | — |

Build emphasis from font, weight and text tier. Fit new content into an existing size.

### Alignment

Left-align body copy, labels and button text. A button with an icon and a label, such as "Forget
everything", stays left-aligned when its text wraps, because a centred label re-centres each line
and looks misaligned. If a label might wrap, prefer `white-space: nowrap` in a fixed-width container.

## Buttons

### Corner radius

| Token | Radius | Used for |
|---|---|---|
| **Radius 1** | Sharp (0px) | The default: top bar, X-ray view and cards, footprint and "Forget everything" pills, rail icons, X-ray close. |
| **Radius 2** | 10px | Prompt-example buttons and the chat input only. |
| **Radius 3** | Fully rounded | Small calls to action inside the chat: the send button and toggle pills such as "Web search" and "Read aloud". The onboarding CTAs are also fully rounded. They sit in a modal outside the chat surface. |

Never fully round a card, panel or anything larger than a button.

### Rest-state fill

A bordered or ghost button, such as "Forget everything" or a status pill like "Time online", must be
visible at rest. A Border 2 outline around a fill that matches the page isn't enough.

- Fill the button one Background tier up from the surface behind it. On Background 1, fill with
  Background 2. Inside a Background 2 card or panel, fill with Background 3. A transparent fill, or
  one that matches the surface behind it, isn't allowed.
- The hover and active ink tint layers on top of this fill.
- The rule applies to every bordered or ghost button and status pill, destructive or not.

### States

- **Hover and active.** Text and icon move toward full white (Text 1). Bordered and ghost buttons
  add an ink-tint background on top of the rest-state fill. Filled accent buttons (send, X-ray
  close) drop the opacity of their own fill.
- **Disabled.** `opacity-40` on the existing fill.

These button states are separate from the icon hover tile in [Iconography](#iconography), which
applies to nav and utility icons.

## Surfaces

- The whole widget sits in one rounded outer container with a soft drop shadow and a hairline
  border. That container has the only permanent shadow. Everything inside is flat, except the chat
  input, which shows a soft drop shadow on hover.
- The top bar is pure black, outside the three Background tones. Nothing else uses pure black.
- The onboarding modal blurs the background behind it (~95% Background 1). Nothing else uses blur.
- X-ray cards use a Background tone as their fill. Two card states appear side by side in the same
  list:
  - **Expanded** cards have public documentation to link to. They get an Accent 1 border and a small
    Accent 1 "···" tag chip in the top-left corner, sized like a badge. They show one
    organisation or subtitle line, one description line, and one or more links (for example,
    "GITHUB" or "TECHNICAL REPORT").
  - **Compact** cards are internal routing or plumbing services with nothing public to link to. They
    use Border 2 with no accent, badge or description, and show the name and category tag on one
    row.

  The expanded card is the only place an accent appears as a full-perimeter line. It is still never
  a fill.

## Iconography

### Library

Use [Remix Icon](https://remixicon.com) for every icon. Each icon is a single `<path>` on a `24×24`
viewBox and comes in `-line` and `-fill` variants.

- **Fill icons** (`-fill`) are for the most important icons: destructive actions such as "Forget
  everything", and anything of equal weight.
- **Line icons** (`-line`) are the default for everything else: settings, new chat, navigation,
  close.
- Where Remix Icon offers more than one version of a glyph, pick the one with square, sharp
  terminals.
- Both variants are filled outline shapes (`fill="currentColor"`). Set the colour with
  `fill`/`color` and the size with `width`/`height`, keeping the `24 24` viewBox. `stroke` and
  `stroke-width` have no effect on these paths.

### Colour

- **Line icons are always Text 1.** If an icon needs an accent, use its fill variant.
- **Fill icons are Text 1, Accent 1 or Accent 2**, chosen by the rules in [Accents](#accents).
- **Stat chips** are the one exception. The footprint pill's lightning bolt and clock are solid
  glyphs, each in a small accent-filled chip that marks it as a data highlight, with a dark glyph for
  contrast. The chip is a sharp square (Radius 1) or a full circle, never a rounded square. Don't
  extend this treatment to other stats, badges or accent fills.

### Labels

Use an icon with a label by default. Icon-only controls are the send button, the X-ray close button
and the collapsed rail icons, which use `aria-label`.

### Interaction states

- **Rest.** A nav or utility icon (menu, compose, flag) sits on the surface behind it: a Text 1
  glyph with no fill, border or shadow.
- **Hover.** A square, sharp-cornered tile (Radius 1) appears behind the icon, filled white @ 15%,
  and the cursor changes to a pointer. Apply this to every clickable icon without its own fill.
  Icons with an accent fill at rest (send, X-ray close) use their opacity drop instead.
- **Active or selected.** The same tile at white @ 30%.

## Footprint hover card

The footprint stats have two levels of detail:

1. **Compact**, always visible: a pill with an icon chip, a short label and a value, for example
   "⚡ You consumed: 0.1Wh · 🕐 Time online: 1m".
2. **Expanded**, on hover: a card anchored to the pill with a plain-language headline ("You have
   spent 1 min with Alpha this session"), the two stats as a vertical list, and one line of
   real-world context ("about 28 sec of a 10-watt LED bulb").

The expanded card uses a light surface with dark text. It is the only light surface in the chat
window. Use that inversion only for transient, supplementary overlays like this one. For a new
"hover for more detail" element, reuse this compact-then-expanded structure.
