import { describe, it, expect } from 'vitest';
import type { FlagKey } from '../../src/lib/chat/server/flagKeys';
import { assertKnownFlagKeys } from '../scenarios/helpers/flagOverride';

describe('setFlagOverrides key check (CUR-4588)', () => {
	it('throws on a key flagKeys.ts no longer registers, instead of forcing a flag that does nothing', () => {
		// The shape document-attachments.spec.ts carried: a retired key reaching the helper through a
		// map the type cannot see into.
		const flags = { 'better-auth-signin': true } as Record<string, boolean> as Partial<
			Record<FlagKey, boolean>
		>;
		expect(() => assertKnownFlagKeys(flags)).toThrow(/better-auth-signin/);
	});

	it('accepts registered keys', () => {
		expect(() =>
			assertKnownFlagKeys({ 'document-attachments': true, 'agent-mode': false })
		).not.toThrow();
	});
});
