// The text journeyStep attaches for one visit to a row. Kept apart from journeyStep.ts so a
// unit spec can read it without loading Playwright.
//
// A visit's note heads the snapshot because the grader reads frames and this text, and some actions
// leave nothing in either: a reload lands on the same screen it left. The note is what tells the
// grader the second snapshot of a row came after one. A failure line goes above the note, since the
// grader most needs to know the row broke.
export function snapshotBody(snapshot: string, note?: string, failure?: string): string {
	let text = snapshot;
	if (note) text = `(this visit: ${note})\n${text}`;
	if (failure !== undefined) text = `(this step failed here: ${failure})\n${text}`;
	return text;
}
