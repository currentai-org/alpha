-- CUR-741/CUR-915: shareConversationsWithModelAuthors lived inside settings.doc (JSONB), never its own
-- column. CUR-741 removed the toggle's UI, type, and API schema entries — no user can see or set this
-- value anymore — but left it sitting in every existing row at whatever it was last set to (925 of 928
-- rows still carried the pre-flip default `true`). Unreachable and unrevocable is not the same as off:
-- purge the key entirely rather than leave a value nobody consented to and nobody can undo.
UPDATE "settings"
SET "doc" = "doc" - 'shareConversationsWithModelAuthors'
WHERE "doc" ? 'shareConversationsWithModelAuthors';
