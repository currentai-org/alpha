import { describe, expect, it } from "vitest";
import { settingsExternalLinks, settingsNavInputs, settingsSections } from "./settingsSections";

const base = "/chat";
const routingHref = `${base}/settings/routing`;
const sections = (input: { devTools: boolean; autoRoutingEnabled: boolean }) =>
	settingsSections({ base, path: `${base}/settings`, signedIn: false, ...input });

describe("Settings → Model routing is developer-only, not live for visitors on prod", () => {
	it("is absent for a visitor without developer tools, even with Auto on", () => {
		expect(sections({ devTools: false, autoRoutingEnabled: true }).map((s) => s.href)).not.toContain(routingHref);
	});

	it("shows with a Dev badge for the local dev server or an admin, with Auto on or off", () => {
		for (const autoRoutingEnabled of [true, false]) {
			const entry = sections({ devTools: true, autoRoutingEnabled }).find((s) => s.href === routingHref);
			expect(entry, `autoRoutingEnabled=${autoRoutingEnabled}`).toMatchObject({ group: "potluck", badge: "Dev" });
		}
	});
});

// The Connectors tab follows the `mcp-servers` flag the layout data carries
// (`mcpServersEnabled`), for a guest as well as a signed-in account, since a guest's choices are
// kept by session.
const hrefs = (pageData: object, signedIn: boolean) =>
	settingsSections({ base, path: `${base}/settings/connectors`, ...settingsNavInputs(pageData), signedIn }).map(
		(s) => s.href
	);

describe("the Connectors settings tab", () => {
	it("is listed when mcp-servers is on, signed in or not", () => {
		expect(hrefs({ mcpServersEnabled: true }, false)).toContain("/chat/settings/connectors");
		expect(hrefs({ mcpServersEnabled: true }, true)).toContain("/chat/settings/connectors");
	});

	it("is not listed when mcp-servers is off or the layout data does not say", () => {
		expect(hrefs({ mcpServersEnabled: false }, true)).not.toContain("/chat/settings/connectors");
		expect(hrefs({}, true)).not.toContain("/chat/settings/connectors");
	});
});

// The sidebar, the settings layout and the phone-width list each read the section gates through
// settingsNavInputs, so a gate read wrong here is wrong in all three places at once.
describe("settingsNavInputs reads every section gate from the layout data", () => {
	it("counts a visitor as signed in only when login is on and there is a user", () => {
		expect(settingsNavInputs({ loginEnabled: true, user: { id: "u" } }).signedIn).toBe(true);
		expect(settingsNavInputs({ loginEnabled: false, user: { id: "u" } }).signedIn).toBe(false);
		expect(settingsNavInputs({ loginEnabled: true }).signedIn).toBe(false);
	});

	it("passes the per-account gates through as the layout data states them", () => {
		expect(
			settingsNavInputs({ localInferenceEnabled: false, custodialStorageEnabled: true })
		).toMatchObject({ localInferenceEnabled: false, custodialStorageEnabled: true });
	});
});

describe("the Archived chats settings tab", () => {
	it("is listed for a guest and for a signed-in account, because an archive is kept by session too", () => {
		expect(hrefs({}, false)).toContain("/chat/settings/archived");
		expect(hrefs({}, true)).toContain("/chat/settings/archived");
	});
});

describe("the settings list's Status page link follows the deployment's status page", () => {
	const status = (url: string | null | undefined) => settingsExternalLinks(url).find((l) => l.label === "Status page");

	it("links to status.aipotluck.org where the layout says that is the page (hosted)", () => {
		expect(status("https://status.aipotluck.org")?.href).toBe("https://status.aipotluck.org");
	});

	it("links to the operator's own page when STATUS_PAGE_URL names one", () => {
		expect(status("https://status.example.org")?.href).toBe("https://status.example.org");
	});

	it.each([null, undefined, ""])("leaves the link out, never pointing at ours, when there is no status page (%s)", (url) => {
		expect(status(url)).toBeUndefined();
		expect(settingsExternalLinks(url).map((l) => l.href)).toEqual(["/privacy-notice"]);
	});
});
