import { describe, expect, it } from 'vitest';
import RULES from '$lib/chat/server/rules.json';
import { safetySignature, safetySnapshot } from './safetySnapshot';

// The snapshot is the ONE chat-lib read the adapter makes. These assertions pin what Folkways
// relies on: every declared rule is reported, the hash is stable, and "declared" is never
// shown as "enforced" unless the host's own turn policy says so.
describe('folkways-adapter safetySnapshot', () => {
	const declaredKeys = Object.keys(RULES).filter((k) => k !== '_shield');

	it('reports every rule declared in rules.json, in file order, with its public label', async () => {
		const s = await safetySnapshot();
		expect(s.snapshot_version).toBe('1');
		expect(s.rule_count).toBe(declaredKeys.length);
		expect(s.rules.map((r) => r.key)).toEqual(declaredKeys);
		for (const r of s.rules) expect(r.label.length).toBeGreaterThan(0);
	});

	it('marks guard rules (query, tier, action) apart from guardExempt rules (reason, no query)', async () => {
		const s = await safetySnapshot();
		const guard = s.rules.filter((r) => r.enforcement === 'guard');
		const exempt = s.rules.filter((r) => r.enforcement === 'exempt');
		expect(guard.length + exempt.length).toBe(s.rule_count);
		expect(s.guard_rule_count).toBe(guard.length);
		for (const r of guard) {
			expect(r.query?.length).toBeGreaterThan(0);
			expect(['child', 'content']).toContain(r.tier);
			expect(['block', 'log']).toContain(r.action);
		}
		for (const r of exempt) {
			expect(r.query).toBeNull();
			expect(r.action).toBeNull();
			expect(r.exempt_reason?.length).toBeGreaterThan(0);
		}
		// rules.json carries at least one of each today; if that changes, the view must still be honest.
		expect(guard.length).toBeGreaterThan(0);
	});

	it('loads the validated policy (shield knobs present, hash stable over the enforced set)', async () => {
		const s = await safetySnapshot();
		expect(s.policy_valid).toBe(true);
		expect(s.shield).not.toBeNull();
		expect(s.rules_hash).toMatch(/^rules_[0-9a-f]{16}$/);
		expect((await safetySnapshot()).rules_hash).toBe(s.rules_hash);
	});

	it('ties rules_json_enforced to the detector, never to the catalog', async () => {
		const s = await safetySnapshot();
		expect(s.rules_json_enforced).toBe(s.detector === 'shieldstral');
	});

	it('signature changes only with the facts Folkways should be re-told about', async () => {
		const s = await safetySnapshot();
		expect(safetySignature(s)).toBe(safetySignature({ ...s, rules: [], rule_count: 0 }));
		expect(safetySignature(s)).not.toBe(
			safetySignature({ ...s, output_moderation: !s.output_moderation })
		);
	});
});
