// Signed-out/guest landing-page starter prompts (CUR-620). The layout server samples `count` of
// these at random per visit rather than always showing the same ones — see
// $lib/chat/utils/starterRotation and +layout.server.ts. The tuning panel can still override this
// whole pool live via page.data.starters (see $lib/chat/server/tuning); rotation runs over whichever
// pool is active, operator-set or this default.
//
// Five categories, each engineered to show something real rather than just gesture at it:
//   - grounded → web search + citations/provenance
//   - ordinary useful help
//   - not built for one country
//   - does not flatter you
//   - honest about itself
//
// RULES FOR THE POOL: nothing that needs typing, pasting, attaching, or signing in; every prompt
// runs on one click. Nothing that needs a capability we haven't tested; a prompt that fails on click
// is worse than a stale one. The last two categories are where a bad answer costs the most, so every
// prompt is run for real against a live model and confirmed to give a good answer before it ships.
// That rules out a recency-dependent prompt ("What actually changed in the EU AI Act this year?")
// while search grounding does not reliably fire for it, and a prompt the model refuses or answers
// wrongly on some runs: phrase it so it holds up on every run (e.g. "the strongest case against"
// rather than "convince me I'm wrong"). `pnpm --dir web probe:starters` re-grades the pool.
//
// If a prompt deliberately surfaces a known stack gap, a matching entry can be added to
// starterGaps.ts (only when the node genuinely matches; see that file's CURATION RULE). The
// electric-cars fact-check below carries such an entry.
export const suggestions: string[] = [
	// Grounded — exercises web search + citations/provenance
	"Fact-check this: electric cars are worse for the climate than petrol cars once you count the battery.",
	// Ordinary useful help
	"How do I write a polite message to a landlord who keeps ignoring a repair request?",
	"What should I check before signing a rental contract?",
	// Not built for one country
	"What does a day of public transit look like in Bogotá compared to Tokyo?",
	"Explain how a mortgage works, in Portuguese, to someone who has never had one.",
	// Does not flatter you
	"I think social media should be banned for under-16s. Where is that argument strongest, and where does it fall apart?",
	"Nuclear power is the only realistic way to decarbonise. What is the strongest case against that?",
	// Drawn from how people use chatbots (CUR-690): checking a claim, news, practical help, money,
	// writing. They replace two prompts that asked about Alpha itself rather than the visitor's own
	// question. A prompt reaches the shelf only once starterRecord.json grades it, so one that fails
	// live stays in this file without being offered.
	"Is it true that most of the plastic people put in recycling bins is never recycled? Show me where the answer comes from.",
	// "What actually changed in the EU AI Act this year, and what is still undecided?" is not offered
	// (CUR-2553): answers present the 2024 adoption as this year's news, and the output screen can
	// truncate them.
	"My electricity bill doubled this quarter, what are the usual reasons and what should I check first?",
	"Explain what an ETF is to someone who has never bought anything financial before.",
	"I need to write to a public administration in German and my German is basic. Help me ask for a document I was promised and never received.",
];
