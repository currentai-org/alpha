// Ambient types for dsLedger.mjs, covering the exports consumed from typed source (version.spec.ts).
import type { Ledger } from "../../../packages/alpha-ds/src/version/ledger.ts";

export const WEB: string;
export const DS: string;
export const CHANGELOG_DIR: string;
export function readLedgerFiles(): Record<string, string>;
export function loadLedger(): Ledger;
export function extractSurface(): Promise<Set<string>>;
export function isVersionedPath(path: string): boolean;
export function branchChanges(
	base: string
): { base: string; mergeBase: string; versioned: string[]; entries: string[] } | null;
