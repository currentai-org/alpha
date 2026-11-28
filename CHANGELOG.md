# Changelog

## [0.3.0-preview.2](https://github.com/currentai-org/alpha/compare/v0.3.0-preview.1...v0.3.0-preview.2) (2026-11-28)

### Bug Fixes

* **deploy:** the compose stack runs the self-host edition ([#19](https://github.com/currentai-org/alpha/pull/19))

### Features

* **web:** a person's own MCP server can sign in with OAuth instead of a static token ([#14](https://github.com/currentai-org/alpha/pull/14))

## [0.3.0-preview.1](https://github.com/currentai-org/alpha/commits/v0.3.0-preview.1) (2026-11-28)

Known issue: started from `deploy/compose.yaml`, this release declines every chat turn, because that file does
not set the self-host edition. Use 0.3.0-preview.2 or later, or start from `selfhost/compose.yaml`.

### Bug Fixes

* **web:** restore the Vercel build script, so a deploy migrates the database ([#16](https://github.com/currentai-org/alpha/pull/16))
* the web image leaves out the backup job's test fixtures ([#4](https://github.com/currentai-org/alpha/pull/4))
* the chat-host site-page check follows the installation's deployment file ([#5](https://github.com/currentai-org/alpha/pull/5))
* Large 4 reads its own 524k context, not the 32k floor, when its lane renames it ([#6](https://github.com/currentai-org/alpha/pull/6))

### Features

* while a search runs, the live log shows each web search by number, then its source count ([#8](https://github.com/currentai-org/alpha/pull/8))
* an answer's Second opinion button starts the panel, not just X-ray ([#7](https://github.com/currentai-org/alpha/pull/7))
* **ci:** main deploys to the develop host, and a release tag deploys production ([#15](https://github.com/currentai-org/alpha/pull/15))
