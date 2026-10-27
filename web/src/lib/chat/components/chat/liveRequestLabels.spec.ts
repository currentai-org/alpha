import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import {
	PRESTREAM_ACCEPTED_PHASE,
	PRESTREAM_STARTING_PHASE,
	PHASE_PREFIX
} from '$lib/chat/types/MessageUpdate';
import {
	elapsedLabel,
	failoverLine,
	latchModelLabel,
	liveActiveLine,
	liveModelLabel,
	UNKNOWN_MODEL_LABEL
} from './liveRequestLabels';
import { chromeCopy } from '$lib/chat/chromeCopy';

// The copy itself is the contract, so the spec states it rather than importing it.
const PRE_PHASE_LINE = 'Working on it…';
const FIXED_REPLY_LINE = 'Replying with a fixed notice…';

// The contract, stated rather than described: the live line must never name a model that did not serve
// the turn, and must not name one at all before anything identifies it.
//
// A hardcoded "Apertus is …" string would assert Apertus on every turn, including turns a backup
// model answered, and nothing could report that: a static string has no input to disagree with.
// These tests give it one.

describe('liveModelLabel — most-measured source wins', () => {
	it('prefers the MEASURED backend over the selected id — the whole point', () => {
		// The backup lane answered. Naming Apertus here is the defect.
		expect(
			liveModelLabel({
				measured: 'zai-org/GLM-5.2',
				selected: 'swiss-ai/apertus-v1.5-70b'
			})
		).toBe('GLM 5.2');
	});

	it('falls to the SELECTED id when nothing has been measured yet', () => {
		// Pre-first-token, which is most of this component's life.
		expect(liveModelLabel({ selected: 'swiss-ai/apertus-v1.5-70b' })).toBe('Apertus 1.5 70B');
	});

	it('says a generic noun when nothing identifies the model — never a brand', () => {
		// The state with the least evidence must not be the state that guesses. Defaulting to Apertus
		// here would name a model that may not be the one answering.
		expect(liveModelLabel({})).toBe(UNKNOWN_MODEL_LABEL);
		expect(liveModelLabel({ measured: '   ' })).toBe(UNKNOWN_MODEL_LABEL);
	});
});

// The sequence this closes: across the /chat → /chat/conversation/<id> navigation the SAME element
// would read "Apertus 70B is computing…" and then, about a second later, "The model is computing…".
// Each frame is honest on its own; the sequence is a flicker.
describe('latchModelLabel — a resolved name cannot un-resolve mid-turn', () => {
	it('holds the last real name when the sources briefly drop out', () => {
		expect(latchModelLabel('Apertus 70B', UNKNOWN_MODEL_LABEL)).toBe('Apertus 70B');
	});

	it('still reports the generic before anything has ever resolved', () => {
		// The latch must not invent a name it never had — that would name a model that may not have served the turn.
		expect(latchModelLabel(undefined, UNKNOWN_MODEL_LABEL)).toBe(UNKNOWN_MODEL_LABEL);
		expect(latchModelLabel(UNKNOWN_MODEL_LABEL, UNKNOWN_MODEL_LABEL)).toBe(UNKNOWN_MODEL_LABEL);
	});

	it('a real current value always wins — the latch upgrades unknown, it does not pin known', () => {
		// One-directional by design. If a measurement ever disagreed with the held value, the measurement
		// is the one to trust; this must never become a cache that outranks the backend.
		expect(latchModelLabel('Apertus 70B', 'GLM 5.2')).toBe('GLM 5.2');
	});

	it('replays the measured prod sequence and stays resolved throughout', () => {
		let held: string | undefined;
		const frames = ['Apertus 70B', UNKNOWN_MODEL_LABEL, UNKNOWN_MODEL_LABEL, 'Apertus 70B'];
		const out = frames.map((f) => (held = latchModelLabel(held, f)));
		expect(out).toEqual(['Apertus 70B', 'Apertus 70B', 'Apertus 70B', 'Apertus 70B']);
	});
});

describe('latchModelLabel — an agent task never borrows the selected model\'s name', () => {
	it('drops the held selected-model name once the agent route lands with no model reported', () => {
		// Agent-service serves its own model and names it only on the last frame. The name held from before
		// the route landed is the conversation's selected model, which did not serve this task.
		expect(
			latchModelLabel('Mistral Large 3', UNKNOWN_MODEL_LABEL, { route: 'agent', model: '' })
		).toBe(UNKNOWN_MODEL_LABEL);
	});

	it('shows the model the agent reports as soon as it reports one', () => {
		expect(
			latchModelLabel('Mistral Large 3', 'Mistral Medium 3.5', {
				route: 'agent',
				model: 'mistral-medium-2604'
			})
		).toBe('Mistral Medium 3.5');
	});

	it('keeps holding the name on a non-agent route (unchanged)', () => {
		expect(latchModelLabel('Apertus 70B', UNKNOWN_MODEL_LABEL, { route: 'auto', model: '' })).toBe(
			'Apertus 70B'
		);
	});
});

describe('liveActiveLine — a code sandbox waiting for a slot (CUR-4584)', () => {
	it('says it is waiting for a free sandbox, even after the answer has started streaming', () => {
		expect(liveActiveLine({ phase: 'waiting-sandbox', answered: false, modelLabel: 'Mistral Large 3' })).toBe(
			'Waiting for a free sandbox…'
		);
		expect(liveActiveLine({ phase: 'waiting-sandbox', answered: true, modelLabel: 'Mistral Large 3' })).toBe(
			'Waiting for a free sandbox…'
		);
	});

	it('hands the line back once the wait is over', () => {
		expect(liveActiveLine({ phase: 'sandbox-ready', answered: true, modelLabel: 'GLM 5.2' })).toBe(
			liveActiveLine({ answered: true, modelLabel: 'GLM 5.2' })
		);
	});

	it('follows the visitor language', () => {
		expect(
			liveActiveLine({ phase: 'waiting-sandbox', answered: false, modelLabel: 'x', copy: chromeCopy('de') })
		).toBe('Warte auf eine freie Sandbox…');
	});
});

describe('liveActiveLine — what the pulsing line says', () => {
	it('names the model once real tokens are streaming', () => {
		expect(liveActiveLine({ answered: true, modelLabel: 'GLM 5.2' })).toBe(
			'GLM 5.2 is generating…'
		);
	});

	it('names the model while it computes', () => {
		expect(liveActiveLine({ phase: 'thinking', answered: false, modelLabel: 'Apertus 70B' })).toBe(
			'Apertus 70B is computing…'
		);
	});

	it('does NOT name the model for the safety screen or the web search', () => {
		// These describe work around the turn, not work the model does — Coop runs the screen, and it is
		// a different vendor. Attributing either to the model would be a false claim of its own.
		const screening = liveActiveLine({
			phase: 'screening',
			answered: false,
			modelLabel: 'GLM 5.2'
		});
		const searching = liveActiveLine({
			phase: 'searching',
			answered: false,
			modelLabel: 'GLM 5.2'
		});
		expect(screening).not.toMatch(/GLM/);
		expect(searching).not.toMatch(/GLM/);
		expect(screening).toMatch(/safety/i);
		expect(searching).toMatch(/searching the web/i);
	});

	it('a turn that searches only our documents never says it is searching the web (CUR-2223)', () => {
		const line = (phase: string) =>
			liveActiveLine({ phase, answered: false, modelLabel: 'GLM 5.2' });
		for (const phase of ['screening', 'screening-documents', 'searching-documents']) {
			expect(line(phase), phase).not.toMatch(/web/i);
		}
		expect(line('screening-documents')).toMatch(/our documents/);
		expect(line('searching-documents')).toMatch(/our documents/);
		expect(line('screening')).not.toMatch(/documents|sources/);
		// And a turn whose web retrieval really runs says so.
		for (const phase of [
			'screening-web',
			'screening-documents-web',
			'searching',
			'searching-documents-web'
		]) {
			expect(line(phase), phase).toMatch(/the web/);
		}
		expect(line('screening-documents-web')).toMatch(/our documents/);
		expect(line('searching-documents-web')).toMatch(/our documents/);
	});

	it('a long paste shows which part the safety screen is on, after the same screening line (CUR-3749)', () => {
		const line = (phase: string) =>
			liveActiveLine({ phase, answered: false, modelLabel: 'GLM 5.2' });
		expect(line('screening@4/9')).toBe('Checking safety… part 4 of 9');
		expect(line('screening-documents-web@9/9')).toBe(
			'Checking safety & searching our documents and the web… part 9 of 9'
		);
		// A suffix that does not parse falls back to the plain line, never "part NaN".
		for (const bad of ['screening@', 'screening@x/9', 'screening@10/9', 'screening@0/9']) {
			expect(line(bad), bad).toBe('Checking safety…');
		}
		expect(
			liveActiveLine({ phase: 'screening@2/3', answered: false, modelLabel: 'x', copy: chromeCopy('fr') })
		).toBe('Vérification de sécurité… partie 2 sur 3');
	});

	it('gives the pre-pass window its own line instead of leaving a finished phase on screen', () => {
		// The defect: no marker existed between the search/screen phase and `thinking`, so whichever of
		// those fired last stayed up for the whole forced-tool-call window (stage 2 alone has a p90 of about 13 s) — asserting retrieval or the safety screen was still running when it had finished.
		// Every phase in the real sequence must now say something different from its neighbour, or the
		// rail is back to one label across two different waits.
		const sequence = [
			'screening',
			'screening-documents',
			'screening-web',
			'screening-documents-web',
			'searching',
			'thinking'
		];
		const lines = sequence.map((phase) =>
			liveActiveLine({ phase, answered: false, modelLabel: 'Apertus 70B' })
		);
		expect(new Set(lines).size).toBe(sequence.length);
		// And none of them may be the unmapped fallback, which would mean a marker the server emits has
		// no label and silently reads as the generic "working…" line.
		expect(lines).not.toContain(PRE_PHASE_LINE);
	});

	// The line must not name a model before any was called, and must not stay up through
	// fixed replies no model writes. (CUR-1579 / CUR-1978)
	it('names no model before the first phase marker, whatever model is selected', () => {
		expect(liveActiveLine({ answered: false, modelLabel: 'Apertus 70B' })).toBe(PRE_PHASE_LINE);
		expect(
			liveActiveLine({ phase: 'some-new-phase', answered: false, modelLabel: 'The model' })
		).toBe(PRE_PHASE_LINE);
		expect(PRE_PHASE_LINE).not.toMatch(/model|Apertus|GLM/i);
	});

	it('names no model on a fixed reply, even once its text is streaming (CUR-1579, CUR-1978)', () => {
		for (const answered of [false, true]) {
			for (const phase of [undefined, 'thinking', 'screening']) {
				expect(
					liveActiveLine({ phase, answered, modelLabel: 'Apertus 1.5 70B', fixed: true })
				).toBe(FIXED_REPLY_LINE);
			}
		}
		expect(FIXED_REPLY_LINE).not.toMatch(/model|Apertus|GLM|generating|computing/i);
	});

	it('names the audio wait, not the model, once speech synthesis has started (CUR-2210)', () => {
		for (const answered of [false, true]) {
			for (const phase of [undefined, 'thinking', 'writing']) {
				const line = liveActiveLine({
					phase,
					answered,
					modelLabel: 'Apertus 1.5 70B',
					speaking: true
				});
				expect(line).toBe('Making the audio…');
			}
		}
	});

	it('says the model is writing on a read-aloud turn, whose tokens never reach the client (CUR-2210)', () => {
		expect(liveActiveLine({ phase: 'writing', answered: false, modelLabel: 'GLM 5.2' })).toBe(
			'GLM 5.2 is writing the reply…'
		);
		expect(liveActiveLine({ phase: 'writing', answered: false, modelLabel: 'GLM 5.2' })).not.toBe(
			liveActiveLine({ phase: 'thinking', answered: false, modelLabel: 'GLM 5.2' })
		);
	});

	it('streaming beats every phase marker — a stale marker cannot outrank real tokens', () => {
		expect(liveActiveLine({ phase: 'thinking', answered: true, modelLabel: 'Apertus 70B' })).toBe(
			'Apertus 70B is generating…'
		);
	});

	// No line this function can produce may say "Apertus" when Apertus is not the resolved model.
	// Every phase is enumerated rather than spot-checked, because a test of one line would pass while
	// the others stayed wrong.
	it('never says Apertus for a non-Apertus model, on any phase', () => {
		const label = liveModelLabel({ measured: 'zai-org/GLM-5.2' });
		for (const phase of [undefined, 'screening', 'searching', 'thinking', 'unknown']) {
			for (const answered of [true, false]) {
				expect(liveActiveLine({ phase, answered, modelLabel: label })).not.toMatch(/Apertus/);
			}
		}
	});
});

// CUR-1348. The failure this names is drift, not a wrong string: a server that emits
// `phaseMarker("foo")` with no case in liveActiveLine renders the generic "Working on it…"
// fallback, which looks like a working spinner and is exactly the uninformative line this whole rail
// exists to replace. Nothing connects the two files, so the check has to read one against the other.
//
// `starting` and `accepted` are excluded deliberately: they are pre-stream protocol markers, swallowed
// by the client's own vet before they ever reach a label (see MessageUpdate.ts's PRESTREAM_* block).
describe('every phase the server emits has a label', () => {
	const PROTOCOL_ONLY = new Set(
		[PRESTREAM_STARTING_PHASE, PRESTREAM_ACCEPTED_PHASE].map((m) => m.slice(PHASE_PREFIX.length))
	);

	it('finds no server-emitted phase that falls through to the generic line', () => {
		const sources = globSync('src/**/*.ts', { cwd: process.cwd() }).filter(
			(f) => !f.endsWith('.spec.ts')
		);
		const emitted = new Set<string>();
		for (const file of sources) {
			for (const m of readFileSync(file, 'utf8').matchAll(/phaseMarker\("([a-zA-Z0-9_-]+)"\)/g)) {
				emitted.add(m[1]);
			}
		}

		// If this is empty the scan itself broke (a rename, a moved directory) and the test would pass
		// for the wrong reason — the shape rule 2 of the repo's testing guidance is about.
		expect(emitted.size).toBeGreaterThan(0);

		const unlabelled = [...emitted]
			.filter((phase) => !PROTOCOL_ONLY.has(phase))
			.filter(
				(phase) =>
					liveActiveLine({ phase, answered: false, modelLabel: 'Apertus 70B' }) === PRE_PHASE_LINE
			);
		expect(unlabelled).toEqual([]);
	});
});

// The live log names both models when a backup takes over, so the earlier "<primary> is
// computing…" reads as the first half of a switch rather than as a claim the badge then contradicts. (CUR-2239)
describe('failoverLine — both models, and why the switch happened', () => {
	const from = 'swiss-ai/apertus-v1.5-70b';
	const to = 'zai-org/GLM-5.3';

	it("names the primary that didn't answer and the backup that did", () => {
		expect(failoverLine({ from, to, reason: 'unavailable' })).toBe(
			"Apertus 1.5 70B didn't answer · switched to GLM 5.3 (backup)"
		);
	});

	it('says skipped when the primary was never tried', () => {
		expect(failoverLine({ from, to, reason: 'skipped' })).toBe(
			'Apertus 1.5 70B was skipped · switched to GLM 5.3 (backup)'
		);
	});

	// The direct lane's backup arrives as the wire id `mistral-medium-2604`, which once rendered
	// raw ("mistral medium 2604") beside a properly named primary in the same sentence. (CUR-2516)
	it('names the Mistral Medium backup by its model name, cased like the primary, never by its wire id', () => {
		expect(
			failoverLine({ from: 'mistral-large-2512', to: 'mistral-medium-2604', reason: 'unavailable' })
		).toBe("Mistral Large 3 didn't answer · switched to Mistral Medium 3.5 (backup)");
	});
});

describe('elapsedLabel — a step that holds says how long it has run (CUR-1756)', () => {
	it('shows nothing for a step that finishes inside five seconds, so an ordinary turn is unchanged', () => {
		expect(elapsedLabel(0)).toBe('');
		expect(elapsedLabel(4999)).toBe('');
	});

	it('counts whole seconds from five on', () => {
		expect(elapsedLabel(5000)).toBe('5s');
		expect(elapsedLabel(44_800)).toBe('44s');
	});
});
