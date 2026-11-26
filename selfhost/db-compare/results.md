# What each app leaves readable in its database after the same ten chats

Ten chats per app, one message each, typed into the app's own chat page by `chats.mjs`. Every message
carries `PLUM-HERON-4471`; every model reply (titles included) carries `ANSWER-KESTREL-9302`. Written by
`selfhost/db-compare/run.sh`.

| App | Store | Chats | User canary in dump | Answer canary in dump | Fields holding chat text (rows with user · answer canary) |
| --- | --- | --- | --- | --- | --- |
| open-webui | SQLite (`webui.db`) | ok | 50 | 40 | `chat.title` (10 · 0)<br>`chat.chat` (10 · 10)<br>`chat_message.content` (10 · 10)<br>`chat_message.output` (0 · 10) |
| librechat | MongoDB (`mongodump` archive) | ok | 10 | 20 | `messages.text` (10 · 0)<br>`messages.content.text` (0 · 10)<br>`conversations.title` (0 · 10) |
| alpha | Postgres (`pg_dump`), image built from this checkout | ok | 10 | 70 | `conversations.doc` (10 · 10)<br>`generation_events.payload` (0 · 19) |
