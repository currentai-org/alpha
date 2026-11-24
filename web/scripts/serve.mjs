// The container image's start command (web/Dockerfile). The image has no shell, so this does what a
// `sh -c` wrapper did before: fill in the environment self-hosting supplies by other names, apply the
// database migrations, then serve.
//
// The migrator runs as its own process, as it did under the shell (it calls process.exit on every
// path), and a non-zero exit stops here, so the server never starts on a schema it doesn't match. The
// server then runs in this process, PID 1, so SIGTERM reaches its graceful shutdown.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";

const log = (msg) => console.log(`[serve] ${msg}`);
const env = process.env;

// deploy/'s names for the S3 key pair, for an .env carried over from that stack. The app reads only the
// AWS_* pair, through the AWS SDK's default chain.
if (!env.AWS_ACCESS_KEY_ID && env.FILES_ACCESS_KEY) env.AWS_ACCESS_KEY_ID = env.FILES_ACCESS_KEY;
if (!env.AWS_SECRET_ACCESS_KEY && env.FILES_SECRET_KEY) env.AWS_SECRET_ACCESS_KEY = env.FILES_SECRET_KEY;

// selfhost/compose.yaml's --profile agent: agent-init leaves agent-service's token in the agent-token
// volume. The volume outlives the profile, so the token is taken only while an `agent` host resolves on
// the network. The log names the token by a sha256 prefix, never its value.
const TOKEN_FILE = "/agent-token/token";
if (!env.AGENT_SERVICE_TOKEN) {
	let token = "";
	try {
		token = readFileSync(TOKEN_FILE, "utf8").trim();
	} catch {
		// No --profile agent volume: nothing to adopt.
	}
	if (token) {
		const reachable = await lookup("agent").then(
			() => true,
			() => false
		);
		if (reachable) {
			env.AGENT_SERVICE_TOKEN = token;
			env.AGENT_SERVICE_URL ||= "http://agent:8731";
			const print = createHash("sha256").update(token).digest("hex").slice(0, 12);
			log(`agent mode: token from ${TOKEN_FILE} (sha256 ${print}), AGENT_SERVICE_URL=${env.AGENT_SERVICE_URL}`);
		} else {
			log(`agent mode off: ${TOKEN_FILE} is set but no agent host resolves`);
		}
	}
}

const migrate = spawnSync(process.execPath, [new URL("./db-migrate.mjs", import.meta.url).pathname], {
	stdio: "inherit",
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
await import("../build/index.js");
