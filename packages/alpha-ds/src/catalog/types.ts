/**
 * The documentation contract. Every folder under components/, primitives/ and patterns/ ships a
 * `<name>.docs.ts` default-exporting a `DocEntry`, plus an `examples/` folder of real Svelte files.
 * The /designsystem catalog discovers both by convention (see registry.ts) — there is no list to
 * update, and example code is read from the same file that renders the preview, so the two can
 * never drift.
 */

export type Layer = 'foundation' | 'component' | 'primitive' | 'pattern';

export interface PropDoc {
	name: string;
	type: string;
	default?: string;
	description: string;
}

export interface AttrDoc {
	name: string;
	description: string;
}

export interface PartDoc {
	/** Part name as used in markup, e.g. `Accordion.Trigger`. */
	name: string;
	description: string;
	/** The engine part it wraps (e.g. `bits-ui Accordion.Content`) or `native <button>`. */
	engine?: string;
	props?: PropDoc[];
	/** Data attributes the part exposes for styling (Base UI vocabulary; see tokens/variants.css). */
	dataAttributes?: AttrDoc[];
	cssVariables?: AttrDoc[];
}

export interface ExampleDoc {
	/** File name inside `examples/`, without extension. The first example is the hero demo. */
	file: string;
	title: string;
	description?: string;
}

export interface DocEntry {
	/** URL slug under /designsystem. Must equal the folder name. */
	slug: string;
	name: string;
	layer: Layer;
	/** One sentence: what it is and when to reach for it. */
	description: string;
	/** Extra search terms. */
	keywords?: string[];
	/**
	 * The Base UI component this mirrors, or null when it is an Alpha-only addition (Badge, Kbd…).
	 * Agents upgrading a component start from this URL.
	 */
	baseUi: { name: string; url: string } | null;
	/** Where we knowingly differ from Base UI, so an upgrade does not "fix" a deliberate choice. */
	deviations?: string[];
	/** Anatomy snippet (markup skeleton). */
	anatomy?: string;
	parts?: PartDoc[];
	examples: ExampleDoc[];
	/** Spec-derived usage rules, rendered as Do / Don't. */
	guidelines?: { do?: string[]; dont?: string[] };
}
