import { describe, expect, it } from 'vitest';
import { functionRegionsFor, regionBesideDatabase } from './functionRegion.js';

// Made-up endpoint ids; only the region part of the host matters.
const EU =
	'postgresql://u:p@ep-example-a1b2c3-pooler.eu-central-1.aws.neon.tech/db?sslmode=require';
const US =
	'postgresql://u:p@ep-example-d4e5f6-pooler.c-9.us-east-1.aws.neon.tech/db?sslmode=require';

describe('functionRegionsFor — functions run beside the database unless FUNCTION_REGION names a region', () => {
	it('puts a Frankfurt Neon database beside fra1 (a PR preview on its own branch)', () => {
		expect(functionRegionsFor({ DATABASE_URL: EU })).toEqual(['fra1']);
	});

	it('puts a us-east-1 Neon database beside iad1, including a host with a cell prefix', () => {
		expect(functionRegionsFor({ DATABASE_URL: US })).toEqual(['iad1']);
	});

	it('falls back to POSTGRES_URL when DATABASE_URL is unset', () => {
		expect(functionRegionsFor({ POSTGRES_URL: EU })).toEqual(['fra1']);
	});

	it('keeps FUNCTION_REGION over the database, as production sets it', () => {
		expect(functionRegionsFor({ FUNCTION_REGION: 'fra1', DATABASE_URL: US })).toEqual(['fra1']);
		expect(functionRegionsFor({ FUNCTION_REGION: ' iad1, cle1 ', DATABASE_URL: EU })).toEqual([
			'iad1',
			'cle1'
		]);
	});

	it('treats a blank FUNCTION_REGION as unset', () => {
		expect(functionRegionsFor({ FUNCTION_REGION: '  ', DATABASE_URL: EU })).toEqual(['fra1']);
	});

	it.each([
		['unset', undefined],
		['a local database', 'postgresql://u:p@localhost:5432/db'],
		['a Neon region with no mapping', 'postgresql://u:p@ep-x.ap-northeast-9.aws.neon.tech/db'],
		[
			'a host that only contains a region name',
			'postgresql://u:p@eu-central-1.aws.neon.tech.example.org/db'
		],
		['not a URL', 'eu-central-1']
	])('names no region (Vercel keeps its default) when the database URL is %s', (_label, url) => {
		expect(regionBesideDatabase(url)).toBeUndefined();
		expect(functionRegionsFor({ DATABASE_URL: url })).toEqual([]);
	});
});
