import type { NextItem } from './types';

export interface SampleItem {
	runId: string;
	safety: boolean;
	prompt: string;
	answer: string;
	reference: string[];
}

type SampleCalibration = Pick<Extract<NextItem, { kind: 'calibration' }>, 'prompt' | 'answer' | 'expected' | 'explanation'>;

/** Generated preview answers. Ratings made through this adapter stay in the browser. */
export interface GeneratedSamples {
	version: 1;
	items: Record<string, SampleItem[]>;
	calibration: Record<string, SampleCalibration>;
}
