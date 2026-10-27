import { z } from 'zod';
import { EVAL_LANGUAGES } from './languages';
import type { GeneratedSamples } from './samples';

const nonempty = z.string().trim().min(1);
const schema = z.object({
	version: z.literal(1),
	items: z.record(z.string(), z.array(z.object({
		runId: nonempty,
		safety: z.boolean(),
		prompt: nonempty,
		answer: nonempty,
		reference: z.array(z.string())
	}))),
	calibration: z.record(z.string(), z.object({
		prompt: nonempty,
		answer: nonempty,
		expected: z.record(z.string(), z.union([z.number(), z.string()])),
		explanation: nonempty
	}))
});

export function parseGeneratedSamples(value: unknown): GeneratedSamples | null {
	const samples = schema.parse(value);
	const languages = new Set(EVAL_LANGUAGES.map((l) => l.id));
	for (const language of [...Object.keys(samples.items), ...Object.keys(samples.calibration)]) {
		if (!languages.has(language)) throw new Error(`Unknown generated evaluation language: ${language}`);
	}
	return Object.values(samples.items).some((items) => items.length) ? samples : null;
}
