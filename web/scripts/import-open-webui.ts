/**
 * Brings an Open WebUI install's people, conversations and uploaded files into Alpha.
 *
 *   pnpm import:open-webui <webui.db> --dry-run              read and convert, write nothing
 *   pnpm import:open-webui <webui.db>                        write into the database DATABASE_URL names
 *   pnpm import:open-webui postgresql://…/openwebui          read an install that runs on Postgres
 *   OPEN_WEBUI_DATABASE_URL=postgresql://… pnpm import:open-webui   the same, keeping the password out of argv
 *   pnpm import:open-webui chat-export.json --as <email>  a chat file from Open WebUI's Export chats, or
 *                                                         Alpha's Open WebUI download, into one account
 *
 * Options:
 *   --oauth-provider <key>     the key under user.oauth holding the subject id (default oidc)
 *   --schema <name>            Open WebUI's DATABASE_SCHEMA, for a Postgres source that sets one
 *   --data-dir <dir>           Open WebUI's DATA_DIR, where uploads/ lives (default: the folder holding webui.db)
 *   --storage-provider <name>  Open WebUI's STORAGE_PROVIDER (default: $STORAGE_PROVIDER, else local);
 *                              s3 reads s3:// paths with the install's S3_* env
 *   --no-files                 leave uploaded files out of this run (they are reported as skipped)
 *   --as <email>               for a chat file: the account its chats go to (matched on email, created if absent)
 *   --model <id>               the model the conversations are stored under (default: Alpha's default model)
 *
 * The source is only ever read: a SQLite file is opened read-only, a Postgres one inside a READ ONLY
 * transaction. A database at a revision this importer has not been checked against is refused,
 * naming the revision found. Files go through Alpha's upload path, so each passes the safety scan and
 * gets a text sidecar. Safe to rerun: a conversation already imported is left alone unless the source
 * changed, and a file already stored is not uploaded again. Prints a parity report; exits 1 when in
 * does not equal out, 2 when the source is refused or the arguments are wrong.
 */
import "./setups/harnessEnv"; // FIRST: strip blank scaffold env so `??` reads default correctly
import { dirname } from "node:path";
import { exitCleanly } from "./exitCleanly";
import { readFileSync } from "node:fs";
import { readOpenWebUiSqlite } from "../src/lib/chat/server/openWebUiImport/readSqlite";
import { readOpenWebUiChatFile } from "../src/lib/chat/server/openWebUiImport/readChatFile";
import { isPostgresUrl, readOpenWebUiPostgres } from "../src/lib/chat/server/openWebUiImport/readPostgres";
import { UnsupportedSourceError } from "../src/lib/chat/shared/openWebUiImport/sourceSchema";
import { formatReport, reportParity, reportSealRefused } from "../src/lib/chat/server/openWebUiImport/report";
import { alphaFileDeps, fileLocator, type S3Settings } from "../src/lib/chat/server/openWebUiImport/files";

const args = process.argv.slice(2);
const VALUED = ["--oauth-provider", "--schema", "--data-dir", "--storage-provider", "--as", "--model"] as const;
const value = (flag: (typeof VALUED)[number]) => {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const noFiles = args.includes("--no-files");
const oauthProvider = value("--oauth-provider") ?? "oidc";
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1] as never));
const sourceArg = positional[0] ?? process.env.OPEN_WEBUI_DATABASE_URL;

// Open WebUI's own S3 env names, read here and not in src/: they configure the install being read, not Alpha.
const s3: S3Settings = {
	accessKeyId: process.env.S3_ACCESS_KEY_ID || undefined,
	secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || undefined,
	region: process.env.S3_REGION_NAME || undefined,
	endpoint: process.env.S3_ENDPOINT_URL || undefined,
	addressingStyle: process.env.S3_ADDRESSING_STYLE || undefined,
};

async function main(): Promise<number> {
	const missingValue = VALUED.some((f) => args.includes(f) && !value(f));
	const chatFile = Boolean(sourceArg?.toLowerCase().endsWith(".json"));
	const owner = value("--as")?.trim();
	if (positional.length > 1 || !sourceArg || missingValue || (chatFile && !owner)) {
		console.error(
			"usage: pnpm import:open-webui <webui.db | postgresql://…> [--dry-run] [--oauth-provider <key>] [--schema <name>]\n" +
				"       [--data-dir <Open WebUI DATA_DIR>] [--storage-provider local|s3] [--no-files] [--model <id>]\n" +
				"       pnpm import:open-webui <chat-export.json> --as <email> [--dry-run] [--model <id>]\n" +
				"       (or set OPEN_WEBUI_DATABASE_URL instead of passing a Postgres URL)"
		);
		return 2;
	}
	const postgresSource = isPostgresUrl(sourceArg);
	let source;
	try {
		source = chatFile
			? readOpenWebUiChatFile(readFileSync(sourceArg, "utf8"), { email: owner! })
			: postgresSource
				? await readOpenWebUiPostgres(sourceArg, { schema: value("--schema") })
				: readOpenWebUiSqlite(sourceArg);
	} catch (e) {
		if (e instanceof UnsupportedSourceError) {
			console.error(`import:open-webui: refused: ${e.message}`);
			return 2;
		}
		throw e;
	}
	const dataDir = value("--data-dir") ?? (postgresSource ? null : dirname(sourceArg));
	// A chat file holds no uploads, so there is no file store to read.
	const files =
		noFiles || chatFile
			? undefined
			: alphaFileDeps(
					fileLocator({
						dataDir,
						storageProvider: value("--storage-provider") ?? process.env.STORAGE_PROVIDER ?? "local",
						s3,
					})
				);
	// Loaded after the source is accepted, so a refused source never touches Alpha's database or its env.
	const { runImport } = await import("../src/lib/chat/server/openWebUiImport/importer");
	const model =
		value("--model") ?? (dryRun ? "dry-run" : (await import("../src/lib/chat/server/models")).defaultModel.id);
	const report = await runImport(source, { model, oauthProvider, dryRun, files });
	console.log(formatReport(report));
	if (!dryRun) await (await import("../src/lib/chat/server/db/client")).closeDb();
	// A person whose chats were refused because history is sealed here and they have no key: exit 1.
	return reportParity(report) && !reportSealRefused(report) ? 0 : 1;
}

// Top-level await: vite-node closes its module server when the entry module finishes evaluating, and the
// dynamic imports in main() need it open.
try {
	exitCleanly(await main());
} catch (e) {
	console.error("import:open-webui: failed:", e);
	exitCleanly(1);
}
