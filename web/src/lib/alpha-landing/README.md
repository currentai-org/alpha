# The /alpha landing page

`/alpha` is Alpha's product page: a hero, the feature sections and the FAQ, in three visual
directions ("looks", `looks/looks.ts`; Bold is the default). Editorial copy comes from the Payload
`alpha-landing` global (`content.ts` holds the English bootstrap/outage defaults).

## Its one way in is the real chat

The hero's main button (`hero.ctaHref`, resolved through `chatLinkHref`; tagged `data-hero-cta` in the
Bold and Classic looks, which specs drive) opens the
real chat: on the site host of a split installation that is the chat host (`chatHost` in the
deployment file, `src/lib/deployment.ts`), elsewhere `/chat`. A guest can chat there
without signing in and sees only their own conversations.

## The demo is retired

`/alpha` used to embed the chat app on sample data, and "Try the demo" opened it full screen at
`/alpha/demo`. Visitors read its sidebar of made-up chats in five languages as other people's
conversations, and its sign-up wall on send as a login requirement, so it was removed:

- `/alpha/demo` now answers a 308 to the real chat (`routes/alpha/demo/+server.ts`), so old links and
  bookmarks land there too.
- `e2e/scenarios/alpha-demo-retired.spec.ts` pins both: no demo, no sample chats and no demo link on
  `/alpha`, and the main button reaching an empty guest chat.

Don't bring a demo back without solving what sank this one: a preview of the app has to read as a
preview, and never as someone else's history.

## Feature pictures

The feature cards (`bentos/`) are the site's own code: the page imports nothing from chat, so it can
stay behind when chat moves to its own repo. Theme and Instructions run live. Language, Data,
Footprint, Model and X-ray show a picture of the feature in Alpha (`PictureBento.svelte`). The heading and line of copy above each picture stay live text.

Each picture is `static/alpha-features/<name>.<locale>.webp`, one per locale, at twice its CSS size
(`bentos/pictures.ts` lists the sizes). They were captured from the chat components the cards used to
run, which are gone now. To update one, screenshot the same feature in Alpha in each locale at 2x, crop
it to the card's scene, and save it under the same name; `bentos/pictures.spec.ts` fails while a
locale is missing.

The facts the landing states about Alpha (guest retention, where chats are stored, who runs Apertus)
are in `chatFacts.ts`, and `chatFacts.spec.ts` checks each against chat's source. The Potluck mark is
the site's `/favicon.svg`, drawn as a mask (`PotluckGlyph.svelte`).
