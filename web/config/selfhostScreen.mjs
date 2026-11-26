// The self-host Shieldstral screen's first passes. On a self-host edition screening with
// Shieldstral, a text chunk asks each group's question once, and asks that group's rules only when the
// answer is yes or missing, never on a no (guardGate.ts, firstPassesFor). Child rules and every rule outside a group are asked as
// before. On the safety profile's CPU a benign turn then makes 11 classifier calls instead of 17. The
// hosted screen never reads this.
//
// A group is here only if, on the calibration fixtures (scripts/lib/shieldFixtures.mjs), its question
// scored at or above its threshold on every turn one of its rules fired on. Groups for violence, drugs,
// sexual content, anthropomorphism, privacy and fraud lose verdicts on the calibration fixtures, so
// those rules stay asked one by one. The threshold sits low because a false yes costs one round of calls and a false no loses
// a verdict. Rerun `node scripts/guard-first-pass-parity.mjs` after changing a group or any of its
// rules' queries.

/** How many calls the safety profile's classifier serves at once: `--parallel` on the shieldstral
 *  service in selfhost/compose.yaml. The self-host screen sends no more than this, so no call waits
 *  inside llama.cpp behind a full set of slots and spends its share of the screen's deadline queued.
 *  Change both together. */
export const SELFHOST_CLASSIFIER_SLOTS = 4;

/** @typedef {{ name: string, query: string, threshold: number, rules: readonly string[] }} FirstPassGroup */

/** @type {readonly FirstPassGroup[]} */
export const SELFHOST_FIRST_PASSES = Object.freeze([
	{
		name: "people",
		query: "Does this content insult, demean, threaten, harass or dehumanize a person or a group of people?",
		threshold: 0.05,
		rules: ["chat-block-harrasment", "chat-block-toxic", "chat-block-hate", "chat-block-hate-advocacy"],
	},
	{
		name: "self-harm-feelings",
		query:
			"Does the writer say they want to die or hurt themselves, do not want to be alive, or feel hopeless about their own life or wonder whether it has any point?",
		threshold: 0.05,
		rules: ["chat-block-self-harm-intent", "chat-block-self-harm-passive", "chat-block-self-harm-hedged"],
	},
	{
		name: "self-harm-acts",
		query:
			"Does this content ask about or describe ways to kill or injure oneself, or to stop eating, purge, or lose a dangerous amount of weight?",
		threshold: 0.05,
		rules: ["chat-block-self-harm", "chat-block-self-harm-eating"],
	},
]);
