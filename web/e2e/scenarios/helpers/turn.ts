import type { Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// When an assistant turn has finished, so a spec can read its whole text.
//
// "Copy to clipboard" is NOT that signal. A code block inside the answer renders its own copy button
// while the turn is still streaming, so a wait on the title returns mid-stream and `innerText()` reads
// "… is generating…". That let data-portability export a half-written answer (CUR-2035) and made
// math-routing's fence fallback read as a missing total when the page showed the right one (CUR-2133).
//
// Retry is: ChatMessage.svelte renders it only once `isTurnStillRunning` is false, including for a turn
// that produced no text (CUR-1652, CUR-1748). An interrupted reply shows Retry too (CUR-2008), so a
// spec that must tell a complete answer from an interrupted one still has to assert on the text.
//
// Returns the locator rather than waiting on it, so the `expect` stays in the spec where the
// spec-isolation gate counts it.

// The label is translated (`message_retry`), so a spec in a French browser sees "Réessayer". Matching
// only "Retry" made every non-English turn read as never finished: gap-card-language's French test
// waited out its 90 s on a turn that had ended. The name is read from every shipped locale.
const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'messages');
const RETRY_LABELS = ['en', 'fr', 'es', 'de'].map(
	(locale) =>
		(
			JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), 'utf-8')) as Record<
				string,
				string
			>
		).message_retry
);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RETRY_NAME = new RegExp(`^(?:${RETRY_LABELS.map(escape).join('|')})$`);

/** The control that appears once `message` (one `[data-message-role="assistant"]`) has finished. */
export function turnDone(message: Locator): Locator {
	return message.getByRole('button', { name: RETRY_NAME });
}
