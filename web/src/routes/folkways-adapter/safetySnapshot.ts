// Folkways adapter — read-only safety snapshot.
//
// This is the ONE place the adapter reads the chat lib, and it reads only three things:
// rules.json (the public-safe rule catalog), the validated guard policy (what the gate
// enforces), and the per-turn policy (which detector is live). Nothing here can change a
// gate. A read view cannot loosen a rule; the gates keep running in the host route before
// and after the model call, outside this adapter.
//
// "Declared" is not "active". rules.json declares the catalog. Whether those entries are
// ENFORCED depends on the host's `guard-primary` flag:
//   ON  → Shieldstral enforces every rules.json entry (rules_json_enforced: true).
//   OFF → Coop enforces its OWN rules; rules.json supplies only labels and decline copy.
// The snapshot says which, so Folkways never shows a rule as active when it is not.

import { createHash } from 'node:crypto';
import RULES from '$lib/chat/server/rules.json';
import { loadGuardPolicy } from '$lib/chat/server/guardPolicy';
import { resolveTurnPolicy } from '$lib/chat/server/guardGate';

// A declared rule is one of two kinds. `guard`: the Shieldstral gate enforces it (it has a yes/no
// query, a tier, an action). `exempt`: rules.json carries a label and decline copy for a Coop
// action name but deliberately NO detector query — the file records why (`guardExempt`). Both
// are reported; dropping the exempt ones would show fewer rules than the host declares.
export type SafetyRuleView = {
	key: string;
	label: string;
	message?: string;
	enforcement: 'guard' | 'exempt';
	tier: 'child' | 'content' | null;
	action: 'block' | 'log' | null;
	threshold?: number;
	query: string | null;
	exempt_reason?: string;
};

export type SafetySnapshot = {
	snapshot_version: '1';
	rules_hash: string;
	policy_valid: boolean;
	detector: 'shieldstral' | 'coop';
	rules_json_enforced: boolean;
	input_screen_configured: boolean;
	output_moderation: boolean;
	shield: { categoryThreshold: number; concurrency: number; operationDeadlineMs: number } | null;
	rule_count: number;
	guard_rule_count: number;
	rules: SafetyRuleView[];
};

type RawRule = {
	label?: string;
	message?: string;
	guard?: { query?: string; action?: string };
	guardExempt?: string;
};
const RAW = RULES as unknown as Record<string, RawRule>;

function ruleHash(material: unknown): string {
	return `rules_${createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16)}`;
}

function declaredEntries(): [string, RawRule][] {
	return Object.entries(RAW).filter(([key]) => key !== '_shield');
}

export async function safetySnapshot(): Promise<SafetySnapshot> {
	const policy = loadGuardPolicy();
	const turn = await resolveTurnPolicy();

	// File order, so the view matches rules.json as an operator reads it.
	const rules: SafetyRuleView[] = declaredEntries().map(([key, r]) => {
		const enforced = policy?.byKey.get(key);
		if (enforced) {
			return {
				key,
				label: r.label ?? key,
				...(r.message ? { message: r.message } : {}),
				enforcement: 'guard',
				tier: enforced.tier,
				action: enforced.action,
				...(enforced.threshold !== undefined ? { threshold: enforced.threshold } : {}),
				query: enforced.query
			};
		}
		if (r.guardExempt !== undefined) {
			return {
				key,
				label: r.label ?? key,
				...(r.message ? { message: r.message } : {}),
				enforcement: 'exempt',
				tier: null,
				action: null,
				query: null,
				exempt_reason: r.guardExempt
			};
		}
		// Only reachable when the policy failed validation: report the raw guard block as declared.
		return {
			key,
			label: r.label ?? key,
			...(r.message ? { message: r.message } : {}),
			enforcement: 'guard',
			tier: null,
			action: r.guard?.action === 'log' ? 'log' : r.guard?.action === 'block' ? 'block' : null,
			query: r.guard?.query ?? null
		};
	});

	return {
		snapshot_version: '1',
		// Hash what is ENFORCED (validated entries + shield knobs), or the raw file when invalid.
		rules_hash: policy
			? ruleHash({ entries: policy.entries, shield: policy.shield })
			: ruleHash(RAW),
		policy_valid: policy !== null,
		detector: turn.useGuardPrimary ? 'shieldstral' : 'coop',
		rules_json_enforced: turn.useGuardPrimary,
		input_screen_configured: turn.screeningFacts.content,
		output_moderation: turn.outputModerationEnabled,
		shield: policy
			? {
					categoryThreshold: policy.shield.categoryThreshold,
					concurrency: policy.shield.concurrency,
					operationDeadlineMs: policy.shield.operationDeadlineMs
				}
			: null,
		rule_count: rules.length,
		guard_rule_count: rules.filter((r) => r.enforcement === 'guard').length,
		rules
	};
}

/** The parts of a snapshot whose change is worth a fresh report to Folkways. */
export function safetySignature(s: SafetySnapshot): string {
	return [
		s.rules_hash,
		s.policy_valid,
		s.detector,
		s.input_screen_configured,
		s.output_moderation
	].join('|');
}
