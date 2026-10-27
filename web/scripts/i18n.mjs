#!/usr/bin/env node
// Interface message catalogs: check them, and fill the gaps with Claude.
//
//   pnpm i18n:check              errors: broken placeholders, unknown keys, CMS locale drift.
//                                warnings: keys missing in a locale, or translated from an older
//                                English string. Both fall back to English at runtime.
//   pnpm i18n:check --strict     warnings fail too (before a release, or once a locale is "done").
//   pnpm i18n:translate          translate every missing or stale key into every locale.
//   pnpm i18n:translate -- --locale it,pt --all
//
// English (`messages/en.json`) is the source. `messages/translated-from.json` records, per locale
// and key, a hash of the English text each translation was made from, so an edited English string
// is retranslated and an untouched one never is.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const MESSAGES = join(WEB, "messages");
const LOCK = join(MESSAGES, "translated-from.json");
const SETTINGS = join(WEB, "project.inlang/settings.json");
const CMS_LOCALES = join(WEB, "../payload/src/locales.json");

const MODEL = "claude-opus-5-5";
const BATCH = 60;

// Names and terms that stay as written in every language.
const GLOSSARY = [
	"Alpha",
	"AI Potluck",
	"Current AI",
	"Apertus",
	"X-ray",
	"Auto",
	"Infomaniak",
	"SEA-LION",
	"Bielik",
	"ALIA",
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const placeholders = (text) =>
	[...text.matchAll(/\{(\w+)\}/g)]
		.map((m) => m[1])
		.sort()
		.join(",");

function load() {
	const { baseLocale, locales } = readJson(SETTINGS);
	const source = readJson(join(MESSAGES, `${baseLocale}.json`));
	delete source.$schema;
	const lock = existsSync(LOCK) ? readJson(LOCK) : {};
	const catalogs = Object.fromEntries(
		locales
			.filter((locale) => locale !== baseLocale)
			.map((locale) => {
				const path = join(MESSAGES, `${locale}.json`);
				return [locale, existsSync(path) ? readJson(path) : {}];
			})
	);
	return { baseLocale, locales, source, lock, catalogs };
}

/** Per locale: keys to (re)translate, and hard errors. */
function audit({ source, lock, catalogs }) {
	const report = {};
	for (const [locale, catalog] of Object.entries(catalogs)) {
		const missing = [];
		const stale = [];
		const errors = [];
		for (const [key, text] of Object.entries(catalog)) {
			if (key === "$schema") continue;
			if (!(key in source)) errors.push(`${key}: not in the English catalog`);
			else if (typeof text !== "string") errors.push(`${key}: not a string`);
			else if (placeholders(text) !== placeholders(source[key])) {
				errors.push(`${key}: placeholders {${placeholders(text)}} ≠ English {${placeholders(source[key])}}`);
			}
		}
		for (const [key, text] of Object.entries(source)) {
			if (!(key in catalog)) missing.push(key);
			else if (lock[locale]?.[key] !== hash(text)) stale.push(key);
		}
		report[locale] = { missing, stale, errors };
	}
	return report;
}

function check(strict) {
	const state = load();
	const report = audit(state);
	let failed = false;
	const cms = existsSync(CMS_LOCALES) ? readJson(CMS_LOCALES) : null;
	if (cms && [...cms.locales].sort().join() !== [...state.locales].sort().join()) {
		console.error(`✗ CMS locales [${cms.locales}] ≠ interface locales [${state.locales}] (payload/src/locales.json)`);
		failed = true;
	}
	for (const [locale, { missing, stale, errors }] of Object.entries(report)) {
		for (const error of errors) console.error(`✗ ${locale} ${error}`);
		failed ||= errors.length > 0;
		const gaps = missing.length + stale.length;
		if (gaps) {
			const mark = strict ? "✗" : "!";
			console[strict ? "error" : "warn"](
				`${mark} ${locale}: ${missing.length} missing (English shown), ${stale.length} stale (older translation shown) — run pnpm i18n:translate`
			);
			failed ||= strict;
		}
	}
	console.log(failed ? "i18n: FAIL" : `i18n: ok (${state.locales.length} locales)`);
	process.exit(failed ? 1 : 0);
}

const Translations = z.object({
	translations: z.array(z.object({ key: z.string(), text: z.string() })),
});

const SYSTEM = `You translate the interface of Alpha, an open-source AI chat assistant made by AI Potluck (Current AI), from English into one target language.

- Write what a native-speaking product designer would ship: natural, concise interface language, not a literal rendering. Match the register of the platform's own apps (informal "you" where that language's software normally uses it).
- Keep these exactly as written: ${GLOSSARY.join(", ")}.
- Keep every {placeholder} exactly, once each; move it wherever the grammar needs it.
- Keep keyboard shortcuts, URLs and punctuation conventions appropriate to the language (e.g. French spacing before ? and :).
- Labels stay short: a button or menu label must not grow much longer than the English.
- Return one translation for every key you are given, and no other keys.`;

async function translateBatch(client, locale, entries) {
	const response = await client.messages.parse({
		model: MODEL,
		max_tokens: 16000,
		output_config: { effort: "low", format: zodOutputFormat(Translations) },
		system: SYSTEM,
		messages: [
			{
				role: "user",
				content: `Target language: ${new Intl.DisplayNames(["en"], { type: "language" }).of(locale)} (${locale}).\n\n${JSON.stringify(
					entries.map(({ key, text, previous }) => ({ key, english: text, ...(previous ? { previous } : {}) })),
					null,
					1
				)}\n\nWhere "previous" is given, the English changed since that translation; keep its wording where it still fits.`,
			},
		],
	});
	if (response.stop_reason === "refusal") throw new Error(`${locale}: request declined`);
	if (!response.parsed_output) throw new Error(`${locale}: no structured output (${response.stop_reason})`);
	return response.parsed_output.translations;
}

async function translate({ only, all }) {
	const state = load();
	const report = audit(state);
	let client;
	let failures = 0;
	await Promise.all(
		Object.entries(state.catalogs)
			.filter(([locale]) => !only || only.includes(locale))
			.map(async ([locale, catalog]) => {
				const keys = all ? Object.keys(state.source) : [...report[locale].missing, ...report[locale].stale];
				if (keys.length === 0) return;
				const result = { ...catalog };
				const lock = (state.lock[locale] ??= {});
				for (let i = 0; i < keys.length; i += BATCH) {
					const entries = keys.slice(i, i + BATCH).map((key) => ({
						key,
						text: state.source[key],
						previous: catalog[key],
					}));
					client ??= new Anthropic();
					const translations = await translateBatch(client, locale, entries);
					for (const { key, text } of translations) {
						if (!(key in state.source)) continue;
						if (placeholders(text) !== placeholders(state.source[key])) {
							console.error(`✗ ${locale} ${key}: placeholders changed; left for the next run`);
							failures++;
							continue;
						}
						result[key] = text;
						lock[key] = hash(state.source[key]);
					}
				}
				// Same key order as English, so diffs line up across locales.
				const ordered = Object.fromEntries(
					Object.keys(state.source)
						.filter((key) => key in result)
						.map((key) => [key, result[key]])
				);
				writeJson(join(MESSAGES, `${locale}.json`), ordered);
				console.log(`${locale}: ${keys.length} translated`);
			})
	);
	const lock = Object.fromEntries(Object.entries(state.lock).sort(([a], [b]) => a.localeCompare(b)));
	writeJson(LOCK, lock);
	if (failures) process.exit(1);
}

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		strict: { type: "boolean", default: false },
		all: { type: "boolean", default: false },
		locale: { type: "string" },
	},
});

if (positionals[0] === "check") check(values.strict);
else if (positionals[0] === "translate") {
	await translate({ only: values.locale?.split(","), all: values.all });
} else {
	console.error("usage: i18n.mjs check [--strict] | translate [--locale xx,yy] [--all]");
	process.exit(2);
}
