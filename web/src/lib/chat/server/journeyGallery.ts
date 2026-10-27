/**
 * The app's side of the journey gallery (CUR-1524), the QA recordings board — the shape `/chat/admin/journeys` reads and the
 * two strings it shares with the publisher.
 *
 * WHY THE CONSTANTS APPEAR TWICE. `scripts/lib/journeyGalleryManifest.mjs` writes these rows and
 * declares the same two values; it also imports `critique-journey.mjs`, which pulls in the OpenAI
 * SDK and reads `.env` at module load, so importing it into the SvelteKit bundle to share a string
 * would be a poor trade. The copies cannot drift instead: `scripts/__tests__/publishJourneyGallery.spec.ts`
 * asserts the two agree, and that assertion fails on any edit to one of them alone.
 */

/** The `config` table key holding the whole manifest. */
export const MANIFEST_KEY = "journey-gallery";

/** Every recording's `files.filename` starts with this. It is also what the publisher deletes by, so
 *  one run's videos replace the last run's rather than accumulating. */
export const VIDEO_PREFIX = "journey-gallery/";

/**
 * What a journey's card says about itself.
 *
 * Ordered loudest first, which is also the order deriveState() decides them in: the two states
 * meaning "you learned nothing about this journey" are settled before any state meaning "this
 * journey is fine". A green that a journey nobody watched could reach would make this page worse
 * than no page.
 *
 * `not-covered` is a fifth, stronger form of the same complaint (CUR-1612): not "this run didn't
 * grade it" but "nothing has ever been written to walk it at all" — a lettered Linear project
 * (docs/journeys/journey-register.json) with no journey doc, so `readJourneyDocs` never even
 * produces a card for buildManifest to derive a normal state for. Without this state the coverage
 * figure could not go below 100%, because the denominator would be "docs that exist" and a project
 * nobody wrote a journey for would be invisible.
 *
 * `flaky` is a sixth state, and a different kind from the other five: it IS real, judged evidence —
 * not one of the "you learned nothing" states above — but weaker evidence than `clean` (CUR-1613). A
 * journey whose only recording exists because an earlier attempt of the same test failed is not
 * a first-try pass. `deriveState` reads the retry count off the recording itself and refuses to
 * call that `clean`.
 */
export type JourneyState =
	| "not-run"
	| "not-graded"
	| "not-covered"
	| "findings"
	| "partial"
	| "flaky"
	| "unproven"
	| "clean";

type JourneyFinding = {
	step: number;
	/** `unseen` (CUR-2245): graded inconclusive on a step the doc's coverage block says a test drives
	 *  or a frame shows. Relabelled by the manifest builder, never emitted by the grader itself.
	 *  `not-run` (SOL-110): the same claim, when the test it names did not run this run. */
	conclusion: "product" | "doc" | "unseen" | "not-run" | "inconclusive";
	observation: string;
	rationale?: string;
	/** The coverage entry that made the claim, present only on `unseen` and `not-run`. */
	claim?: { kind: "spec" | "visual"; test?: string; file?: string; why?: string };
};

/** persona-trace.json's own shape (e2e/scenarios/helpers/personaDriver.ts), copied narrowly rather
 *  than imported — importing e2e/ code into the SvelteKit bundle pulls in Playwright, the same reason
 *  MANIFEST_KEY/VIDEO_PREFIX above are copied rather than shared. Only the fields the card renders
 *  are typed here; `TurnRecord.snapshot` (every interactive element visible before the turn) is real
 *  but not shown on this page. */
type PersonaTrace = {
	persona: string;
	model: string;
	provider: string;
	trace: Array<{
		turn: number;
		action?: { do: string; ref?: number; text?: string; key?: string; why: string };
		/** What the driver actually operated on, as `role "name"`. `action.why` is only the model's
		 *  STATED intent — the first live run had a turn where the two disagreed outright. */
		acted?: string;
		rejected?: string[];
		error?: string;
		url: string;
	}>;
};

type JourneyRecording = {
	slug: string;
	title: string;
	/** Playwright's own result status — "passed", "failed", "timedOut", "interrupted", "skipped". */
	status: string;
	/** A `test.fail()` spec failing as declared, so `status` is "failed" and nothing is (CUR-2234)
	 *  wrong. Absent on a manifest built before the reporter recorded Playwright's outcome. */
	expectedFailure?: boolean;
	/** The `fail` annotation's description, when the spec gave one. */
	expectedFailureReason?: string | null;
	/** An injury proof, a test that passes only when the journey's checks go red under the (CUR-1614)
	 *  fault it is named after (journeyArtifacts.ts). Absent on a recording made before the field. */
	injuryProof?: boolean;
	/** Numbers the spec measured about the product (e2e/scenarios/helpers/measurement.ts), (SOL-103)
	 *  e.g. how long the A1 limit message took. Absent on a manifest built before the field. */
	measurements?: { name: string; value: number; unit: string; detail?: string }[];
	startedAt: string;
	/** The Playwright project that recorded this — `chromium` or `mobile-chromium` today.
	 *  Named `project` because that is what Playwright calls it and what `meta.json` carries, which
	 *  is a different `project` from `JourneyCard.project` below: that one is the journey's roadmap
	 *  title, this one is a viewport. Null for a recording written before the reporter named it.
	 * (CUR-1550)
	 *  The card renders it because two recordings of one test are otherwise the same row twice. */
	project: string | null;
	durationMs: number | null;
	bytes: number;
	/** The `files.filename` this video is stored under, and what the video endpoint is asked for. */
	file: string;
	/** Seconds into the video where the tile starts, just past the opening blank tab.
	 *  Null when the publisher could not read the recording, and absent on a manifest published (CUR-1623)
	 *  before this field existed; the page falls back to a fixed offset for both. */
	startAt?: number | null;
	/** Set when the tab stayed blank for the whole recording (a test skipped before its (CUR-1623)
	 *  first navigation, or a request-only test), so no video was stored and the tile is a caption. */
	noScreen?: "blank";
	/** The adversarial persona series' turn-by-turn record, absent for every non-persona (CUR-1574)
	 *  journey. Null both when nothing was attached and when the file existed but did not parse. */
	personaTrace: PersonaTrace | null;
};

/**
 * One finding from the product critique (CUR-1526) — the pass that watches the same frames WITHOUT
 * the journey doc's step table and asks whether a person would mind. `area` comes from a closed
 * vocabulary, so a card can group by it and the Linear key stays stable run to run.
 */
type PmFinding = {
	area: string;
	severity: "minor" | "annoying" | "blocking";
	observation: string;
	rationale?: string;
	suggestion?: string;
};

/** Null when the product critique did not run for this journey at all. `watched: false` means it ran
 *  and could not produce a verdict, which is a different thing and says so on the card. */
type PmCritique = {
	watched: boolean;
	reason: string | null;
	rejected?: string[];
	findings: PmFinding[];
};

/** Severities that also reach Linear, and therefore the ones a `clean` badge may not sit on top of.
 *  The publisher holds the same list.
 *
 *  This is the filing RULE and never a record of what was filed — membership here says a finding of
 *  that severity is one the workflow's filing step is meant to open a ticket for, not that any
 *  ticket exists (CUR-1670). Nothing on the
 *  page can say otherwise: the filing step runs after the manifest is published, so no ticket id
 *  is available at publish time. */
export const PM_FILED: PmFinding["severity"][] = ["annoying", "blocking"];

/** The viewport clause of the page's configuration line, and the reason CUR-1554 cannot be
 *  forgotten: no mobile cards means either "the viewport is switched off" or "it ran and recorded
 *  nothing", and those look identical on screen while wanting opposite reactions. The run states
 *  what it was CONFIGURED for, and this turns that into the sentence a reader sees first.
 *
 *  Three cases, deliberately — `undefined` is a manifest published before the field existed, and
 *  answering "desktop only" there would present a guess as a fact. It says nothing instead.
 *
 *  Lives here rather than inline in the page so it can be tested in the fast project: the browser
 *  project this would otherwise need fails roughly one run in eleven for reasons unrelated to the
 *  code under test (CUR-1549). */
export function viewportNote(viewports: string[] | undefined): string {
	if (viewports === undefined) return "";
	return viewports.includes("mobile")
		? "desktop and mobile"
		: "desktop only — mobile recording is off";
}

export const SEVERITY_LABEL: Record<PmFinding["severity"], string> = {
	blocking: "would stop the demo",
	annoying: "a person would mind",
	minor: "worth a mention",
};

/**
 * How much of its project a journey's step table walks (CUR-1571).
 *
 * Null when the doc names no `milestones:` key, or when the milestone snapshot has no entry for the
 * project. The card then says nothing about coverage — an unassessed journey must not read as a
 * covered one, and `0 of 0` would be a claim the data cannot support.
 */
type JourneyCoverage = {
	walked: number;
	total: number;
	/** Milestone names the steps do not reach, in the project's own words. */
	unwalked: string[];
	/** Names the doc claims that the project does not have — the doc and the snapshot drifted. */
	unknown: string[];
};

export type JourneyCard = {
	journey: string;
	/** The doc's own `project:` front matter — the card's title, in the words the roadmap uses. */
	project: string;
	/** See JourneyCoverage. Null means "not assessed", never "walks none". */
	coverage: JourneyCoverage | null;
	spec: string;
	persona: string;
	steps: number;
	doc: string;
	state: JourneyState;
	/** One sentence under the badge saying what the state means for this journey specifically. */
	reason: string;
	findings: JourneyFinding[];
	/** What a product manager watching the same frames said, or null if nobody watched (CUR-1526). */
	pm: PmCritique | null;
	/** Titles of the recordings the grader actually judged. */
	graded: string[];
	excluded: { title: string; status: string }[];
	/** Directories holding a video without its meta.json, or the reverse — a partial artifact write
	 *  (CUR-1489). Counted rather than dropped, because a dropped one is indistinguishable from a
	 *  recording that never happened. */
	stale: { slug: string; missing: string }[];
	recordings: JourneyRecording[];
};

type JourneyRun = {
	sha: string;
	ref: string;
	ranAt: string;
	baseUrl: string;
	signedOut: boolean;
	agentMode: boolean;
	/** The search mode the suite's browser starts in. A boolean on runs published before CUR-2030, when
	 *  search defaulted to off and the field could only say on or off. */
	webSearch: boolean | "off" | "auto" | "always";
	/** The viewports this run was CONFIGURED to record — a different fact from which
	 *  recordings came back. `["desktop"]` means mobile was switched off, and the page says so;
	 *  without it, "off" and "on but produced nothing" are the same absence on screen. Absent on a
	 *  manifest published before this field existed, which reads as "we don't know" rather than (CUR-1554)
	 *  as desktop-only. */
	viewports?: string[];
	/** `develop` enters chat on develop's own default; `prod` pins every chat to `model`, (CUR-2285)
	 *  production's default at run time. Absent on runs published before the field existed (develop). */
	profile?: "develop" | "prod";
	model?: string | null;
	suiteExitCode: string | null;
	runUrl: string | null;
	languageProbe: string | null;
};

/** One graded run's verdicts, written by the publisher's `summarizeRun` (CUR-2548). Kept a month in
 *  the manifest so the page can say what changed since an earlier run. */
export type RunSummary = {
	sha: string;
	ranAt: string | null;
	profile: "develop" | "prod";
	model: string | null;
	journeys: Record<
		string,
		{
			state: JourneyState;
			/** The doc grader's conclusions on each step it raised a finding for, keyed by step number. */
			steps: Record<string, string[]>;
			/** The product critique's findings as `area:severity`. */
			pm: string[];
		}
	>;
};

export type JourneyManifest = {
	version: number;
	run: JourneyRun;
	journeys: JourneyCard[];
	/** Newest first, this run included. Absent on a manifest published before CUR-2548. */
	history?: RunSummary[];
	/** What no scenario spec reaches, measured against the app's route tree and flag (CUR-1533)
	 *  registry rather than the journey docs. Absent on a manifest published before it existed. */
	untouched?: UntouchedSurfaces;
};

type UntouchedSurfaces = {
	routesTotal: number;
	/** Page routes no spec opens with a literal goto. */
	routes: string[];
	/** Flags on for an anonymous visitor on preview; null when the flag half was not read. */
	flagsOnInPreview: number | null;
	/** Of those, the ones no spec names. Null when the flag half was not read. */
	flags: string[] | null;
	/** Why the flag half was not read, when it was not. */
	flagsNotRead: string | null;
};

/** Journeys with no verdict in them. A reader skimming for green needs these to be unmissable. */
export const UNJUDGED: JourneyState[] = ["not-run", "not-graded", "not-covered"];

export const STATE_LABEL: Record<JourneyState, string> = {
	"not-run": "Did not run",
	"not-graded": "Not graded",
	"not-covered": "No journey doc",
	findings: "Findings",
	partial: "Partly graded",
	flaky: "Flaky",
	unproven: "Unproven",
	clean: "Clean",
};

/**
 * The word on a card's badge. A clean card may carry minor product-critique notes, which by design do
 * not withhold `clean` (journeyGalleryManifest.mjs), so the badge counts them: a skimmer who trusts
 * "Clean" without opening the card still learns there is something to read (CUR-1707).
 */
export function badgeLabel(j: Pick<JourneyCard, "state" | "pm" | "findings">): string {
	const notes = j.state === "clean" && j.pm?.watched ? j.pm.findings.length : 0;
	if (notes > 0) return `${STATE_LABEL.clean} · ${notes} note${notes === 1 ? "" : "s"}`;
	if (j.state !== "findings") return STATE_LABEL[j.state];
	// "Findings" lumped a broken step in with a doc that is out of date and a step nobody
	// saw, so a reader could not tell from the rail which cards meant a visitor hits something. (CUR-2896)
	const c = findingCounts(j);
	const parts = [
		c.broken > 0 && `${c.broken} broken`,
		c.doc > 0 && `${c.doc} doc out of date`,
		c.unchecked > 0 && `${c.unchecked} not checked`,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : STATE_LABEL.findings;
}

/** What a finding asks of whoever reads it, which is what the card has to say before anything else:
 *  `broken` is something a visitor would hit; `doc` is the journey doc describing an app that has
 *  since moved; `unchecked` is a step nobody saw this run, so it is neither broken nor fine. */
type FindingKind = "broken" | "doc" | "unchecked";

function findingKind(conclusion: JourneyFinding["conclusion"]): FindingKind {
	if (conclusion === "product") return "broken";
	if (conclusion === "doc") return "doc";
	return "unchecked";
}

/** Counts a card's findings by kind. Product-critique findings count as broken only at a severity the
 *  workflow files (PM_FILED), and only when the critique watched; a minor note is not breakage. */
export function findingCounts(j: Pick<JourneyCard, "findings" | "pm">): Record<FindingKind, number> {
	const c: Record<FindingKind, number> = { broken: 0, doc: 0, unchecked: 0 };
	for (const f of j.findings) c[findingKind(f.conclusion)]++;
	if (j.pm?.watched) c.broken += j.pm.findings.filter((f) => PM_FILED.includes(f.severity)).length;
	return c;
}

/** The one thing to do about a doc-grader finding, so no row ends on a description alone. */
export const NEXT_STEP: Record<JourneyFinding["conclusion"], string> = {
	product: "Try this step on www; if it still happens, fix it or file it against the journey's project.",
	doc: "Update this step in the journey doc to match what the app does now.",
	unseen: "Make the named test record this step, or change the doc's coverage line to one that does.",
	"not-run": "Find why the named test did not run, then rerun the gallery.",
	inconclusive: "Rerun the gallery; if it stays inconclusive, add a test or frame that shows this step.",
};

/**
 * The order the rail lists journeys in (CUR-3076): what wants a reader first, then what carries no
 * verdict, then clean, then journeys with no doc. Lower comes first.
 */
const STATE_RANK: Record<JourneyState, number> = {
	findings: 0,
	flaky: 1,
	partial: 2,
	"not-run": 3,
	"not-graded": 4,
	unproven: 5,
	clean: 6,
	"not-covered": 7,
};

/** Journeys failures first, keeping the manifest's order within a state. Returns a new array. */
export function sortFailuresFirst<T extends Pick<JourneyCard, "state">>(journeys: T[]): T[] {
	return journeys
		.map((j, i) => ({ j, i }))
		.sort((a, b) => STATE_RANK[a.j.state] - STATE_RANK[b.j.state] || a.i - b.i)
		.map(({ j }) => j);
}

/**
 * The letter group a journey id belongs to, "A" for A1 and A10, "F" for F9. The roadmap groups its
 * projects this way (A for Alpha, F for foundations, C for chat history...), so it is the filter a
 * reader already thinks in. An id with no leading letters is its own group.
 */
export function journeyGroup(id: string): string {
	return /^[A-Za-z]+/.exec(id)?.[0].toUpperCase() ?? id;
}

/** The distinct groups in a run, in alphabetical order. */
export function journeyGroups(journeys: Pick<JourneyCard, "journey">[]): string[] {
	return [...new Set(journeys.map((j) => journeyGroup(j.journey)))].sort();
}

/**
 * The run's verdict in one line, for the header (CUR-3076). `attention` when a journey has findings,
 * is flaky or partly graded, or a recording failed outside a declared `test.fail()`; `unmeasured` when
 * nothing asks for a look but some journey that has a doc carries no verdict; `clean` otherwise.
 * Journeys with no doc never make a run unmeasured: no re-run can grade them.
 */
export function runVerdict(
	journeys: Pick<JourneyCard, "journey" | "state" | "recordings">[]
): { tone: "attention" | "unmeasured" | "clean"; text: string } {
	const asking = journeys.filter((j) => j.state === "findings" || j.state === "flaky" || j.state === "partial");
	const failed = splitRecordingsByOutcome(journeys).failed;
	const unmeasured = journeys.filter((j) => j.state === "not-run" || j.state === "not-graded");
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	if (asking.length > 0 || failed.length > 0) {
		const parts: string[] = [];
		if (asking.length > 0) parts.push(`${plural(asking.length, "journey asks", "journeys ask")} for a look`);
		if (failed.length > 0) parts.push(`${plural(failed.length, "recording", "recordings")} failed`);
		return { tone: "attention", text: parts.join(" · ") };
	}
	if (unmeasured.length > 0) {
		return {
			tone: "unmeasured",
			text: `Nothing asks for a look, but ${plural(unmeasured.length, "journey", "journeys")} went unmeasured`,
		};
	}
	return { tone: "clean", text: "Every graded journey is clean" };
}

/** One recording the summary names, flattened out of its journey. */
export type RecordingRow = { journey: string; title: string; status: string };

/** What a recording's status reads as on the page: an expected failure is named as one (CUR-2234). */
export function recordingStatusLabel(r: { status: string; expectedFailure?: boolean }): string {
	return r.expectedFailure ? "expected failure" : r.status;
}

/**
 * Every step, across the whole run, that a passing test or a frame claims and the grader never saw
 * (CUR-2245). The summary names them before any card is opened, so they are not drawn in the same
 * grey as steps nothing claims to walk.
 */
export function unseenSteps(
	journeys: Pick<JourneyCard, "journey" | "findings">[]
): { journey: string; step: number }[] {
	return journeys.flatMap((j) =>
		(j.findings ?? [])
			.filter((f) => f.conclusion === "unseen")
			.map((f) => ({ journey: j.journey, step: f.step }))
	);
}

/**
 * Split every non-passed recording into the two things the summary must never merge.
 *
 * `status` is Playwright's own field and carries five values (see `JourneyRecording`), of which
 * `skipped` means the test never ran: no result arrived, so there is nothing to have failed.
 * Filtering on `status !== "passed"` would announce skipped `@preview-only` and persona runs as
 * failures (CUR-1816).
 *
 * The distinction is this page's reason to exist: it tells the reader, about a different set, that a
 * gap in the run is "not a result about the product", so a summary that counts skips as product
 * defects would contradict it.
 *
 * Anything that is neither passed nor skipped (`failed`, `timedOut`, `interrupted`, or a value
 * Playwright adds later) counts as a failure. That is the safe direction: a new status shows up as
 * something to look at rather than disappearing into a quieter sentence.
 */
export function splitRecordingsByOutcome(journeys: Pick<JourneyCard, "journey" | "recordings">[]): {
	failed: RecordingRow[];
	skipped: RecordingRow[];
	/** `test.fail()` specs that failed as declared. Kept out of `failed`, which a reader (CUR-2234)
	 *  takes as something to chase. */
	expected: RecordingRow[];
} {
	const failed: RecordingRow[] = [];
	const skipped: RecordingRow[] = [];
	const expected: RecordingRow[] = [];
	for (const j of journeys) {
		for (const r of j.recordings) {
			if (r.status === "passed") continue;
			const row = { journey: j.journey, title: r.title, status: recordingStatusLabel(r) };
			(r.expectedFailure ? expected : r.status === "skipped" ? skipped : failed).push(row);
		}
	}
	return { failed, skipped, expected };
}

/**
 * Split `UNJUDGED` journeys into the two things "carries no verdict" must never merge.
 *
 * CUR-1814. Naming every unjudged journey in one sentence ("14 of 28 journeys carry no verdict... a
 * gap in the run, not a result about the product") is true of each individually and the wrong shape
 * read together. Journeys with no `docs/journeys/*.md` have nothing for a spec to walk, and no
 * additional test coverage can produce a verdict for them. A journey that has a doc and simply
 * produced nothing to grade in this run is a gap another run can close.
 *
 * The split key is `doc`, not `state`. It would be tempting to key on `state === "not-covered"`
 * instead, since that state's own label is "No journey doc" — but CUR-1574's undocumented-recording
 * cards (an adversarial persona run with no roadmap doc) carry `doc: ""` and can still land in
 * `not-run`/`not-graded`, exactly like a documented journey whose recording never produced a grade.
 * `state` alone cannot tell "nothing was written down" apart from "something was written down and
 * this run didn't reach it"; `doc` is the one field that always can, because `readJourneyDocs` is the
 * only path that ever sets it to a real filename.
 */
export function splitUnjudgedByDoc(journeys: Pick<JourneyCard, "journey" | "doc" | "state">[]): {
	ranButNoVerdict: JourneyCard["journey"][];
	noDocYet: JourneyCard["journey"][];
} {
	const ranButNoVerdict: JourneyCard["journey"][] = [];
	const noDocYet: JourneyCard["journey"][] = [];
	for (const j of journeys) {
		if (!UNJUDGED.includes(j.state)) continue;
		(j.doc ? ranButNoVerdict : noDocYet).push(j.journey);
	}
	return { ranButNoVerdict, noDocYet };
}

/**
 * Give every unjudged card with no journey doc the state `not-covered`, so the state pills, the
 * card badges and the "no doc yet" sentence all count the same journeys.
 *
 * CUR-2266. An undocumented recording (CUR-1574: a persona run, or a journey recorded before its doc
 * was written) lands in `not-graded`, while `splitUnjudgedByDoc` names it under "no doc yet"; this
 * keeps the state pills and the sentence counting the same journeys. Applied when the page reads the
 * stored manifest, so an older manifest reads the same way.
 */
export function withUndocumentedAsNotCovered<J extends Pick<JourneyCard, "doc" | "state">>(journeys: J[]): J[] {
	return journeys.map((j) => (!j.doc && UNJUDGED.includes(j.state) && j.state !== "not-covered" ? { ...j, state: "not-covered" } : j));
}

/**
 * The byte range a `Range: bytes=…` header asks for, `null` for none or a form we don't serve (so
 * the whole file goes back), or `"unsatisfiable"` for a start past the end.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
	if (!m || (m[1] === "" && m[2] === "")) return null;
	if (m[1] === "") {
		// Suffix form, "bytes=-500": the last 500 bytes.
		const n = Math.min(Number(m[2]), size);
		return n > 0 ? { start: size - n, end: size - 1 } : "unsatisfiable";
	}
	const start = Number(m[1]);
	const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	return start >= size || end < start ? "unsatisfiable" : { start, end };
}

/**
 * What changed for each journey between an earlier graded run and this one (CUR-2548), as one short
 * line per change. A journey absent from the result did not change.
 *
 * "Changed" means a verdict moved, never that a recording or its prose differs: the state moved, a
 * step gained or lost a doc-grader conclusion, the product critique raised an `area:severity` it had
 * not before or stopped raising one, or the journey appeared or disappeared. Rewording an observation
 * with the same conclusion is not a change, because the grader rewords every run.
 */
export function changesSince(current: RunSummary, base: RunSummary): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	const add = (j: string, line: string) => (out[j] ??= []).push(line);
	const label = (s: JourneyState) => STATE_LABEL[s] ?? s;
	for (const [j, now] of Object.entries(current.journeys)) {
		const then = base.journeys[j];
		if (!then) {
			add(j, `new since then: ${label(now.state)}`);
			continue;
		}
		if (then.state !== now.state) add(j, `${label(then.state)} → ${label(now.state)}`);
		const steps = [...new Set([...Object.keys(then.steps), ...Object.keys(now.steps)])].sort(
			(a, b) => Number(a) - Number(b)
		);
		for (const step of steps) {
			const before = new Set(then.steps[step] ?? []);
			const after = new Set(now.steps[step] ?? []);
			for (const c of after) if (!before.has(c)) add(j, `step ${step}: new ${c} finding`);
			for (const c of before) if (!after.has(c)) add(j, `step ${step}: ${c} finding gone`);
		}
		const pmBefore = new Set(then.pm);
		const pmAfter = new Set(now.pm);
		for (const k of now.pm) if (!pmBefore.has(k)) add(j, `critic: new ${k.replace(":", " (")})`);
		for (const k of then.pm) if (!pmAfter.has(k)) add(j, `critic: ${k.replace(":", " (")}) gone`);
	}
	for (const j of Object.keys(base.journeys)) {
		if (!current.journeys[j]) add(j, "no longer in the run");
	}
	return out;
}

/**
 * The earlier run a "changed since" view compares against: the newest summary at or before `days`
 * ago when `days` is given, else the previous graded run. Null when history has nothing earlier.
 *
 * @remarks For a window, the newest run AT OR BEFORE its start is the state the window opened on, so
 * the diff covers everything that happened inside it. When history doesn't reach that far back, the
 * oldest run kept stands in, and the page says which run it compared against.
 */
export function baselineRun(history: RunSummary[] | undefined, days: number | null, now = Date.now()): RunSummary | null {
	const earlier = (history ?? []).slice(1);
	if (earlier.length === 0) return null;
	if (days == null) return earlier[0];
	const start = now - days * 24 * 60 * 60 * 1000;
	return earlier.find((s) => s.ranAt != null && Date.parse(s.ranAt) <= start) ?? earlier[earlier.length - 1];
}
