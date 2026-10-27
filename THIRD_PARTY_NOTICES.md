# Third-party notices

The root `LICENSE` (MIT, Copyright (c) 2026 Current AI) covers the code and text Current AI wrote. It does
not cover the third-party material below, which stays under its own licence, and it grants no right to
Current AI's or anyone else's names and logos. This file lists what ships in this tree and was not written
from scratch by Current AI: where it came from, its licence, and where it sits.

## Licence layout

| Path | Licence | Why |
| --- | --- | --- |
| `LICENSE` (root) | MIT | Current AI's own code |
| `web/src/lib/chat/`, `web/src/routes/chat/` and the shared app files named in "Hugging Face chat-ui" below | Apache-2.0 | Derived from Hugging Face chat-ui. Its licence is `web/LICENSE.chat-ui` |
| `agent-service/` | MIT (`agent-service/LICENSE`) | Current AI's own code, same terms as the root |
| `agent-service/deploy/hermes/*.patch` | MIT | Patches to Nous Research's hermes-agent. Licence text: `agent-service/deploy/hermes/LICENSE.hermes` |

`web/package.json` therefore declares `MIT AND Apache-2.0`: the chat subtree is a chat-ui derivative, the rest
is Current AI's.

## Forked and adapted code

| What | Source | Licence | Where |
| --- | --- | --- | --- |
| Chat application | [huggingface/chat-ui](https://github.com/huggingface/chat-ui), forked at commit `caaf90712ce966f45c0ad171f17f0b619861b0c3`, Copyright 2018- The Hugging Face team. The upstream repository carries no NOTICE file. | Apache-2.0 | `web/src/lib/chat/**`, `web/src/routes/chat/**`, and `web/src/app.html`, `web/src/app.d.ts`, `web/src/ambient.d.ts`, `web/src/styles/main.css`, `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/scripts/setups/*`. Files were changed from upstream (storage, auth, model routing, provenance and many other changes); `web/UPSTREAM.md` records the fork point and the path map. Licence text: `web/LICENSE.chat-ui` |
| Markdown block splitter | [vercel/streamdown](https://github.com/vercel/streamdown) `parse-blocks.tsx`, Copyright 2023 Vercel, Inc. | Apache-2.0 | `web/src/lib/chat/utils/parseBlocks.ts` (upstream header kept) |
| Tool-run summary table | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) `summarizeToolRun`, Copyright (c) 2025 Nous Research | MIT (text below) | `web/src/lib/chat/utils/trace/toolRunSummary.ts` |
| ACP edit-approval patch | hermes-agent, Copyright (c) 2025 Nous Research | MIT (text below) | `agent-service/deploy/hermes/0002-acp-confirm-execute.patch` |
| SvelteKit status patch | [sveltejs/kit](https://github.com/sveltejs/kit) 2.70.3 | MIT | `web/patches/@sveltejs__kit@2.70.3.patch` |
| Accept-header negotiation | acceptmarkdown.com's published SvelteKit recipe (`parseAccept`, `preferredType`, `appendVaryAccept`) | Not stated on the source page | `web/src/hooks.server.ts` |
| Guest-library list for the code sandbox | e2b-dev/code-interpreter `template/requirements.txt` | Apache-2.0 | `agent-service/deploy/e2b-template/guest-libraries.txt` (a list of package names) |

## Prompt and evaluation text taken from elsewhere

| What | Source | Licence | Where |
| --- | --- | --- | --- |
| Answer-rating rubric and its questions, adapted from the Multilingual AI Safety Evaluation Lab | Roya Pakzad (Taraaz), built during a Mozilla Foundation fellowship. The credit is shown to raters on the page. | MIT with an attribution clause, Copyright (c) 2025 Roya Pakzad and contributors; full text in `web/src/lib/chat/server/data/eval/LICENSE.multilingual-ai-safety-lab` | `web/src/lib/chat/server/data/eval/rubric-r1.json`, `web/src/lib/chat/server/humanEval/`, `web/src/lib/chat/evaluate/fixtures.ts` |

## Fonts

| Font | Source | Licence | Where |
| --- | --- | --- | --- |
| Inter Regular and Bold, Copyright 2020 The Inter Project Authors | [rsms/inter](https://github.com/rsms/inter) | SIL OFL-1.1 (`web/src/lib/chat/server/fonts/OFL.txt`) | `web/src/lib/chat/server/fonts/Inter-*.ttf` (used to draw share images) |
| Inter, Noto Serif, Plus Jakarta Sans, Cormorant Garamond, DM Mono, DM Sans | npm `@fontsource*` packages, installed from the lockfile, not copied into this tree | SIL OFL-1.1 | Imported by `web/src/app.css` |
| Icon font built from `shared/icons/svg` | Built by `shared/icons/build.mjs` with the fantasticon tool | Drawn for Current AI by its design studio; Current AI's own work | `web/static/fonts/icons/aipotluck-icons.woff2` |

## Logos and trademarks

These are trademarks or brand assets, not code. They are included only to name or credit the organisation
and are not licensed under the MIT licence. Nothing here grants a right to use them.

- Organisation marks in `web/static/logos/` (swiss-ai, bsc, ai-singapore, speakleash, zhipu, mistral, cohere,
  huggingface, openrouter, cloudflare, featherless, infomaniak, cscs, phoeniqs, common-voice,
  mozilla-data-collective). `web/static/logos/README.md` records where each was fetched. Each belongs to its
  organisation.
- Hugging Face and chat-ui marks: the icons in `web/static/chatui/`. The chat-ui code licence does not extend to Hugging Face's marks.
- Current AI and AI Potluck names, logos and illustrations: `web/src/lib/assets/` (`current-ai-*`,
  `aipotluck*`, `alpha-wordmark.svg`), `web/static/ai-potluck-logo.svg`, the `*-og*.png` share images, the
  favicons and web-app icons. Current AI keeps all rights in these.

## Scraped and generated data

| File | Source | Terms | Notes |
| --- | --- | --- | --- |
| `web/static/data/stack-map.json` | Current AI's own description of each layer of Alpha's stack and the component it uses there | Current AI | Names third-party organisations and products only |
| `web/src/lib/chat/search/sourceCredibilityHosts.ts` | Generated by `web/scripts/gen-source-credibility.mjs` from [Wikipedia's perennial sources list](https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources) (rows rated generally unreliable or deprecated) and the [Iffy.news index of unreliable sources](https://iffy.news/index/) | CC BY-SA 4.0 (Wikipedia contributors) and CC BY 4.0 (Iffy.news). This file stays under those licences, not MIT | A list of host names only |

## Dependencies

Installed from the lockfile, not shipped as source. A licence scan of the `web/` workspace
(`pnpm licenses list`) found MIT (1,069), Apache-2.0 (97), ISC (43), BSD (45), OFL-1.1 (6),
MPL-2.0 (7), BlueOak-1.0.0 (9) and a handful of others. No GPL or AGPL package is required. Each package
below is fetched from its registry at install time. None is copied into this tree, and none is patched (the
one patch in `web/patches/` is to `@sveltejs/kit`, which is MIT). Anyone who redistributes a build, a
container image or a modified copy should check these terms for themselves:

- LGPL-3.0: `@img/sharp-libvips-linux-x64` 1.3.4, a prebuilt library that `sharp` loads at run time, and
  `psycopg`, `psycopg-binary` and `psycopg-pool`, used by `agent-service/`. Distributing a build or image
  that bundles them carries the LGPL's conditions.
- `jszip` (MIT OR GPL-3.0-or-later): used under MIT.
- MPL-2.0, whose conditions attach to modified MPL files: `satori`, `@resvg/resvg-js`, `lightningcss`,
  `axe-core`, `@axe-core/playwright`; `dompurify` is MPL-2.0 OR Apache-2.0.
- Others outside the usual permissive set: `caniuse-lite` (CC-BY-4.0, data), `argparse` (Python-2.0),
  `truncate-utf8-bytes` (WTFPL), `duck` ("BSD", no version in the SPDX field), `matplotlib` (Python
  Software Foundation licence), `numpy` (BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0), `reportlab`
  (BSD).

`pnpm-lock.yaml` also resolves packages for the CMS that is not part of this tree.

## Hermes licence text (MIT)

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
