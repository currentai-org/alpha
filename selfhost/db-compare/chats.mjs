// Types the same ten chats into one app's own chat page, as a person would, and waits for each answer.
//
//   node chats.mjs <open-webui|librechat|alpha> <base url> <out dir>
//
// Each app gets a fresh account from its own sign-up route, then ten new chats, one message each. Every
// message carries the user canary (USER_CANARY) and the stub model answers with the answer canary
// (stub.py), so run.sh can find both wherever an app stored them. Run from web/ through `pnpm exec`,
// which resolves Playwright from web/node_modules. Writes <out dir>/<app>-chats.json.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require("@playwright/test");

export const USER_CANARY = "PLUM-HERON-4471";
export const ANSWER_CANARY = "ANSWER-KESTREL-9302";
const TOPICS = ["lantern", "orchard", "glacier", "violin", "harbour", "compass", "meadow", "anvil", "comet", "teapot"];
export const PROMPTS = TOPICS.map(
	(t, i) => `Chat ${i + 1} of 10. My reference is ${USER_CANARY}. Tell me one fact about a ${t}.`
);

const [app, base, out] = process.argv.slice(2);
if (!app || !base || !out) {
	console.error("usage: node chats.mjs <open-webui|librechat|alpha> <base url> <out dir>");
	process.exit(2);
}
const email = `compare-${app}@example.org`;
const password = `Compare-${Math.random().toString(36).slice(2)}-Pw1!`;

async function postJson(url, body, headers = {}) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`POST ${new URL(url).pathname} answered ${res.status}: ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : {};
}

// Per app: sign up and arrive signed in on a new chat page; return the composer and how to start over.
const apps = {
	"open-webui": {
		async signIn(page) {
			const { token } = await postJson(`${base}/api/v1/auths/signup`, { name: "Compare", email, password });
			await page.goto(base);
			await page.evaluate((t) => localStorage.setItem("token", t), token);
			// A new account's first visit opens "What's New in Open WebUI" over the composer.
			const news = page.getByRole("dialog", { name: "What's New in Open WebUI" });
			await page.addLocatorHandler(news, async () => {
				const go = news.getByRole("button", { name: /let'?s go|okay|close/i }).first();
				if (await go.count()) await go.click();
				else await page.keyboard.press("Escape");
			});
		},
		newChat: (page) => page.goto(`${base}/`),
		composer: (page) => page.locator("#chat-input"),
	},
	librechat: {
		async signIn(page) {
			await postJson(`${base}/api/auth/register`, {
				name: "Compare",
				username: `compare${Date.now()}`,
				email,
				password,
				confirm_password: password,
			});
			await page.goto(`${base}/login`);
			await page.locator('input[name="email"]').fill(email);
			await page.locator('input[name="password"]').fill(password);
			await page.locator('button[type="submit"]').click();
			await page.waitForURL(/\/c\//, { timeout: 60_000 });
		},
		newChat: (page) => page.goto(`${base}/c/new`),
		composer: (page) => page.locator("#prompt-textarea"),
	},
	alpha: {
		async signIn(page) {
			// Better Auth's email-and-password sign-up, which a self-host with no mailer offers to its first
			// account (selfHostSignUp.ts). page.request shares the browser's cookies, so the session holds.
			const res = await page.request.post(`${base}/chat/api/auth/sign-up/email`, {
				headers: { origin: base },
				data: { email, password, name: "Compare" },
			});
			if (!res.ok()) throw new Error(`sign-up answered ${res.status()}: ${(await res.text()).slice(0, 300)}`);
			const welcome = page.getByRole("dialog", { name: "Welcome to Alpha" });
			await page.addLocatorHandler(welcome, async () => {
				await welcome.getByRole("button", { name: /start chatting/i }).click();
			});
		},
		newChat: (page) => page.goto(`${base}/`),
		composer: (page) => page.getByLabel("Message AI Potluck"),
	},
};

const drive = apps[app];
if (!drive) throw new Error(`unknown app ${app}`);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
const log = { app, base, email, chats: [] };
try {
	await drive.signIn(page);
	for (const [i, prompt] of PROMPTS.entries()) {
		const t0 = Date.now();
		await drive.newChat(page);
		const box = drive.composer(page);
		await box.waitFor({ state: "visible", timeout: 60_000 });
		await box.click();
		await page.keyboard.type(prompt);
		await page.keyboard.press("Enter");
		const answered = page.getByText(ANSWER_CANARY).first();
		await answered.waitFor({ state: "visible", timeout: 90_000 });
		// Give the app's own background writes (title, tags, the saved turn) time to land.
		await page.waitForTimeout(3000);
		log.chats.push({ n: i + 1, url: page.url(), ms: Date.now() - t0 });
		console.log(`${app}: chat ${i + 1} answered at ${page.url()}`);
	}
} catch (err) {
	await page.screenshot({ path: resolve(out, `${app}-failure.png`), fullPage: true }).catch(() => {});
	log.error = String(err?.message ?? err);
	console.error(`${app}: ${log.error}`);
	process.exitCode = 1;
} finally {
	writeFileSync(resolve(out, `${app}-chats.json`), JSON.stringify(log, null, 1));
	await browser.close();
}
