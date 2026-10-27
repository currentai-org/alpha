# Feature homes

Alpha's chat follows a standard chat-app layout with three regions:

- The **sidebar** is about you and your chats.
- The **thread header** is about the current conversation.
- The **composer** is about the message you're writing.

To place a new feature, decide which region it belongs to. This page lists where each feature lives.

## Sidebar (`NavMenu`, `Sidebar` pattern)

| Feature          | Home                                 | Notes                                                                             |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| New chat         | Top action (`Sidebar.Item emphasis`) | Shortcut ⌘⇧O                                                                      |
| **Search chats** | Top action → `ChatSearchDialog` (⌘K) | Filters loaded conversation titles in the browser; nothing is sent                |
| **Files**        | Action below Search chats            | `/chat/storage`. Shown only when the per-user `custodial-storage-view` gate is on |
| Recents          | `Sidebar.Section`s by date           | The row menu (⋯) has Delete                                                       |
| **Account menu** | One row at the foot → `AccountMenu`  | Holds Report, Appearance, Settings, Account and Log in/out                        |

The account menu has these groups:

- **Settings**
- **Appearance**: Mode (Light, Dark, System) and Theme, each a flyout. The choice persists.
- **Help**: Report a problem (`ReportProblemDialog`), Privacy notice, Trust & safety
- **Workspace**, gated by `workspacesEnabled`
- **Account**, **Log out** or **Log in**

The sidebar header has the **AI Potluck** brand link. `/chat` is a full-page app with no site header
or footer (`routes/+layout.svelte` drops the site chrome on chat routes), so the brand link is the
way back to the rest of the site.

On phones, the sidebar pushes the conversation right and dims it. Rows are 44px tall.

## Thread header (`ThreadHeader` inside `ChatWindow`)

| Feature                             | Home                                         | Notes                                                                      |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| Conversation title                  | Left; becomes a menu once there are messages | Modelled on Claude's title dropdown                                        |
| **Export as Markdown**              | Title menu                                   |                                                                            |
| **Delete conversation**             | Title menu (destructive)                     | Absent in the embed demo and on unsaved chats                              |
| Guest retention                     | "Deletes in 30 days" badge beside the title  | Opens a card with the retention sentence and the reason. No sign-in prompt |
| Session footprint (energy and time) | Right: ⚡ value · 🕒 value → popover         | Summary, two stat tiles, meter, explanation, methodology                   |

The energy meter fills toward an everyday amount, such as a phone charge, a laptop charge or a
kettle boil (`energyAnchor`). The footprint popover opens at the top. "How is this estimated?" shows
a breakdown bar (shares from the estimator's own constants), the uncertainty range on a log scale, a
comparison for scale, and lists of what is and isn't counted.

## Composer (`ChatInput` inside the `Composer` skin)

| Feature                                         | Home                                                             | Notes                                                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attach (images, text file, URL)                 | `+` menu                                                         | One flat menu with no submenu                                                                                                                                               |
| **Web search · Agent · Read aloud · Reasoning** | **Tools menu**, one radio group each, with a caption per option  | The current value is visible where you change it                                                                                                                            |
| Active tools                                    | `Composer.Chip`s beside the Tools button, name only; × turns off | Read aloud and reasoning only. Web search and agent show no chip; their mode shows on the menu row                                                                          |
| Dictate                                         | Mic icon, right of the toolbar                                   |                                                                                                                                                                             |
| **Model choice**                                | **Model picker** in the toolbar, left of dictate                 | "Auto" by default. Its dropdown explains how the model was chosen (language and effort). "Choose a model yourself" opens a flyout with every model, unavailable ones marked |
| **Where your message goes**                     | **Private pill** → width-matched panel (`ComposerAccessory`)     | Credits the model maker, the host and region, and Hugging Face's private storage                                                                                            |
| **X-ray**                                       | **X-ray pill** beside Private → panel (`ComposerAccessory`)      | See [XRAY-PROPOSAL.md](XRAY-PROPOSAL.md)                                                                                                                                    |
| Send / Stop                                     | Accent pill, bottom right                                        |                                                                                                                                                                             |
| Agent and web search conflict                   | Caption inside the Tools menu                                    | Shown only when both are on                                                                                                                                                 |
| "Looks like it needs current info" hint         | Accent dot on the Tools button                                   |                                                                                                                                                                             |

The model picker's Auto row is behind the `auto-routing` flag. With the flag off, the menu lists the
models only, and it reads and writes the model chosen in settings. On phones, the picker opens as a
sheet: Auto, the explanation, then every model in one list.

The composer panels (Private, X-ray) close with the button in the upper right, Escape, or a click
outside. A **Jump to bottom** arrow appears above the composer while you're scrolled away from the
latest message. The latest turn reserves no blank space once it finishes.

## Answers

Answers render as prose on the page with no box around them. The user's turn is a bubble whose
corners follow the theme (`rounded-sharp`: square in Alpha, rounded in Soft). Legacy chat
components use `rounded-sharp` in place of `rounded-none`, so every theme's corners apply to them.

Each answer has one footer line: the maker's logo and name, the model, **How this was made** (opens
X-ray on that answer), then copy, try again, report and alternatives.

- **Answer notes** (`AnswerNote`). The unverified-links, no-name, safety, offline-answer,
  locked-editing and non-answer notices share one shape: icon, short title, optional action, and a
  "What's this?" link that opens the explanation inline. Inline text works on touch screens, where
  hover tooltips don't.
- **Editing a turn** happens inside the bubble, with Cancel and Send in it.
- **Markdown in a code fence** (` ```markdown `, or a whole reply in one unlabelled fence that
  starts with a heading) renders as formatted text (`unwrapMarkdownFences`). Other code blocks are
  left as code.

## Search chats

Press ⌘K to open the palette, which offers "Start a new chat". Typing shows **Ask Alpha: "…"**, which starts a chat with
that text, and matching titles grouped by _Today_, _Yesterday_, _Earlier this week_ and so on, with
relative times and highlighted matches. It searches titles stored on the current device only.

## Welcome

"Welcome to Alpha" is a dialog over the whole app, shown as a bottom sheet on phones. It describes
Alpha, shows the makers' logos, and offers "Take the tour", which starts the guided tour. If you skip
it, a hint above the sidebar's account row says the tour is in that menu.

## New chat backdrop

An empty chat shows the `/alpha` grid field behind the composer, drawn in the theme's accent and
text colours and masked to fade into the surface (`ChatBackdrop`). The composer is centred in the
empty state.

## Phones

Below the `md` breakpoint (`useCompact()`), popovers and inline panels open as a `Sheet`: anchored to
the bottom, with a grab handle, swipe to dismiss, a shared header with title and close button, and a
scroll-faded body. The Private and X-ray panels, the footprint, the retention card, Search chats and
the model picker use it.

## Visual system

- **Scroll shadow.** Every scroller (conversation, sidebar, panels, settings, search) uses
  `scroll-fade-y`.
- **Elevation.** Floating layers use a hairline and a soft shadow (`--ds-shadow-popover`) with no
  hard offset edge. Dialog and popup frames and sidebar rules use the subtle line tokens.
- **Dialogs** scale in from the centre (`motion-dialog`), including the search palette. A popup
  motion that animated `translate` would override the centring and slide the dialog in from the
  right.
- **Corners.** `radius-card` (containers) and `radius-popup` (menus) are theme tokens. Bordered
  `Surface`s, settings cards, tiles and toasts use them. Inside the app, legacy
  `rounded-md/lg/xl/2xl` classes resolve to the theme's tiers through `legacy-bridge.css`, so a
  rounded theme is rounded everywhere.

## Themes

- **Partner themes** (Settings → Appearance → Partner themes): Hugging Face, Mistral, Infomaniak,
  Cohere and Swiss AI. Each uses brand-inspired seeds in the same contrast-solved pipeline, and all
  pass `tokens.spec.ts`. The picker shows a live mini-app preview for each theme, partner logos, and
  a check badge on the selected theme.
- **Live preview.** Hovering a theme card, or a theme in the account menu's Theme flyout, previews
  it on the whole window (`ThemeContext.preview`). Editing a custom theme previews the draft
  (`previewCustom`). Nothing persists until you choose a theme or press **Save theme**.

## `/alpha` demo

The `/alpha` demo behaves like the app: new chat, switching between sample conversations, pills
and search all work. Sign-up appears only when you send a message, and app-only destinations show
an "Open Alpha" note. Feature sections render real components (routing explanation, Private
credits, instructions, X-ray rows).

## Settings

| Feature            | Home                                                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settings**       | A state of the app: the page fills the main column, and the sidebar shows "← Back to app" and the section list | Sections are defined in `chat/settingsSections.ts`, in two groups. Settings: General, Personalization, Appearance, Data & privacy, Account, Workspace, Local inference, Model settings (Dev badge; dev server or admin). Potluck: Model routing (the routing lab), Contribute, Evaluate language (`/chat/settings/evaluate`). Each appears only when its page's gate is on. On phones, a section strip sits above the page |
| Model to configure | "Switch model" popover in the Models section header                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Appearance**     | Settings → Appearance: theme cards (Alpha, Soft, Potluck Paper, with live previews) and mode                   | Themes change colour and shape (corners, elevation, UI type). Mode is also in the account menu                                                                                                                                                                                                                                                                                                                             |
| **Data & privacy** | Settings → Data & privacy                                                                                      | States where chats (the app's own database) and uploaded files (Hugging Face) are stored, the retention period, and **Forget everything**                                                                                                                                                                                                                                                                                  |
| **Workspace**      | Account menu, and Settings → Workspace                                                                         | Organisation-level. Gated by `workspacesEnabled`                                                                                                                                                                                                                                                                                                                                                                           |

## Design decisions

1. **Forget everything** is in Settings → Data & privacy. The header bar doesn't have it. It is a
   destructive, account-wide action unrelated to the current conversation, and a page you open on
   purpose suits it better than a menu row next to "Log out". The footprint stats stay in the header. To move it
   back, pass `forget` (default `true`) to `SessionFootprint` in `ChatWindow`.
2. **X-ray has no right-edge rail.** It opens from the pill under the composer, on every screen
   size, and from each answer's "How this was made" link.
3. **Report a problem** is under Help in the account menu. The sidebar has no top-level action for
   it.
4. **Appearance** offers three explicit choices. There is no row that cycles through modes.

## Open work

The shared `Modal` adapter renders at `size="full"`, so legacy callers keep their old widths. Some
legacy modals (welcome, URL fetch, weak spots) still carry their own inner styling and are tracked
by the lint ratchet.
