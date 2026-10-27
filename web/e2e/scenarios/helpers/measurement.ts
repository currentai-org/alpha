// A number a spec measured about the product, carried to the journey gallery. The spec
// asserts on it as usual; this records it so the recording's card can show the value the check
// passed or failed with. `reporters/journeyArtifacts.ts` reads these annotations into
// meta.json's `measurements` and drops any it cannot parse.
import { test } from '@playwright/test';

export type Measurement = {
	/** What was measured, in words a reader of the gallery understands. */
	name: string;
	value: number;
	unit: string;
	/** How the value breaks down, when that helps a reader judge it. */
	detail?: string;
};

export function recordMeasurement(measurement: Measurement): void {
	test.info().annotations.push({ type: 'measurement', description: JSON.stringify(measurement) });
}
