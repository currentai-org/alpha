import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JourneyCard, JourneyManifest } from "$lib/chat/server/journeyGallery";

// The page reads `page.url` only in onMount and on selection, and calls replaceState only on a
// click; neither router exists when the page is mounted bare, as every client-project test does.
vi.mock("$app/state", () => ({ page: { url: new URL("http://localhost/chat/admin/journeys"), state: {} } }));
vi.mock("$app/navigation", () => ({ replaceState: vi.fn() }));

const { default: Page } = await import("./+page.svelte");

type Recording = JourneyCard["recordings"][number];

function recording(over: Partial<Recording> & Pick<Recording, "slug" | "title" | "status">): Recording {
	return {
		startedAt: "2026-11-14T00:00:00.000Z",
		project: "chromium",
		durationMs: 1000,
		bytes: 1024,
		file: `journeys/${over.slug}/video.webm`,
		noScreen: "blank",
		personaTrace: null,
		...over,
	};
}

function card(over: Partial<JourneyCard> & Pick<JourneyCard, "journey" | "state">): JourneyCard {
	return {
		project: `${over.journey} project`,
		coverage: null,
		spec: "web/e2e/scenarios/example.spec.ts",
		persona: "visitor",
		steps: 3,
		doc: `docs/journeys/${over.journey}.md`,
		reason: "",
		findings: [],
		pm: null,
		graded: [],
		excluded: [],
		stale: [],
		recordings: [],
		...over,
	};
}

function manifest(journeys: JourneyCard[]): JourneyManifest {
	return {
		version: 1,
		run: {
			sha: "abcdef1234567890",
			ref: "develop",
			ranAt: "2026-11-14T00:00:00.000Z",
			baseUrl: "https://develop.example.org",
			signedOut: true,
			agentMode: false,
			webSearch: "auto",
			suiteExitCode: "1",
			runUrl: null,
			languageProbe: null,
		},
		journeys,
	};
}

const pageData = (m: JourneyManifest) => ({
	needsLogin: false,
	signedIn: true,
	role: "admin",
	manifest: m,
	buildSha: m.run.sha,
});

afterEach(() => cleanup());

// the gallery's self-check reads the failed-recordings sentence alone. A known-broken
// (test.fail()) recording that failed as declared belongs in the expected-failures sentence and must
// never be counted among the failures, or a promotion's graded run reads red when the board is right.
describe("the journeys page's failed-recordings sentence", () => {
	it("names the failed recording and omits the known-broken one, which reads as expected instead", async () => {
		const m = manifest([
			card({
				journey: "F9",
				state: "clean",
				recordings: [recording({ slug: "f9-a", title: "the gallery opens on a run", status: "failed" })],
			}),
			card({
				journey: "A1",
				state: "clean",
				recordings: [
					recording({
						slug: "a1-a",
						title: "a second sign-in on an already-used email is told plainly",
						status: "failed",
						expectedFailure: true,
					}),
				],
			}),
		]);
		render(Page, { data: pageData(m) } as never);

		const failed = page.getByTestId("journey-failed-recordings");
		await expect.element(failed).toBeVisible();
		await expect.element(failed).toHaveTextContent(/1\s+recording failed:\s+F9 — the gallery opens on a run\./);
		await expect.element(failed).not.toHaveTextContent(/A1|already-used email/);

		const expected = page.getByTestId("journey-expected-failures");
		await expect.element(expected).toHaveTextContent(/1\s+recording is an expected failure/);
		await expect
			.element(expected)
			.toHaveTextContent(/A1 — a second sign-in on an already-used email is told plainly/);
	});

	it("shows no failed-recordings sentence when the only failure is a known-broken one", async () => {
		const m = manifest([
			card({
				journey: "A1",
				state: "clean",
				recordings: [
					recording({ slug: "a1-a", title: "known broken", status: "failed", expectedFailure: true }),
				],
			}),
		]);
		render(Page, { data: pageData(m) } as never);

		await expect.element(page.getByTestId("journey-expected-failures")).toBeVisible();
		await expect.element(page.getByTestId("journey-failed-recordings")).not.toBeInTheDocument();
	});
});

// a clean card that carries a product-critique note must not read a bare "Clean", or a
// skimmer who trusts the badge misses the note. Seeded here because published runs have had no such card.
describe("the journeys page's clean badge with notes", () => {
	it('reads "Clean · 1 note" on both the rail and the open card for a clean card carrying one note', async () => {
		const m = manifest([
			card({
				journey: "A6",
				state: "clean",
				pm: {
					watched: true,
					reason: null,
					findings: [{ area: "controls", severity: "minor", observation: "The Dictate control is small." }],
				},
				recordings: [recording({ slug: "a6-a", title: "dictates a message", status: "passed" })],
			}),
			card({
				journey: "W1",
				state: "clean",
				pm: { watched: true, reason: null, findings: [] },
				recordings: [recording({ slug: "w1-a", title: "opens the home page", status: "passed" })],
			}),
		]);
		render(Page, { data: pageData(m) } as never);

		const rail = page.getByTestId("journey-rail");
		await expect.element(rail.getByRole("link", { name: /A6/ }).getByTestId("journey-badge")).toHaveTextContent(
			"Clean · 1 note"
		);
		// The card with no notes keeps the bare word, so the two are told apart at a glance.
		await expect.element(rail.getByRole("link", { name: /W1/ }).getByTestId("journey-badge")).toHaveTextContent(
			/^\s*Clean\s*$/
		);
		await rail.getByRole("link", { name: /A6/ }).click();
		await expect.element(page.getByTestId("journey-open-badge")).toHaveTextContent("Clean · 1 note");
	});
});
