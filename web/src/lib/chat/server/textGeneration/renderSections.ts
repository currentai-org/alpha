// What a prompt section is and how a list of them renders. It imports nothing, so both
// persona.ts and promptSections.ts can build section lists from it without importing each other. (CUR-3892)

/**
 * How often a section's text changes: `static` never between deploys, `deployment` with this
 * deployment's config (screening posture, which models are listed), `turn` with the visitor, the
 * model, the clock or the fence. A provider can only cache the prompt up to its first `turn` section.
 */
type SectionStability = "static" | "deployment" | "turn";

export interface PromptSection<C> {
	id: string;
	stability: SectionStability;
	/** The ticket that earned the section its place. */
	ticket: string;
	/** Absent means always rendered. */
	when?: (ctx: C) => boolean;
	/** Several strings are separate paragraphs. Whether the section appears at all is `when`'s call. */
	render: (ctx: C) => string | readonly string[];
}

/** The sections that apply, rendered in list order and joined as paragraphs. */
export function renderSections<C>(sections: ReadonlyArray<PromptSection<C>>, ctx: C): string {
	return sections
		.filter((s) => !s.when || s.when(ctx))
		.flatMap((s) => {
			const out = s.render(ctx);
			return typeof out === "string" ? [out] : [...out];
		})
		.join("\n\n");
}
