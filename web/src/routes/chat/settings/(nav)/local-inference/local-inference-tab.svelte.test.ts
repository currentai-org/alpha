import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import superjson from "superjson";

// safeInvalidate touches $app/navigation's invalidate() + $app/state's navigating, neither of which
// exist outside a real SvelteKit router — this component test mounts the page bare (no router), same
// as every other client-project test here. Mocked wholesale rather than faked piece by piece; what
// matters for THIS test is only that it gets called after a successful add/remove, not how it works —
// that plumbing (and its own reason for existing) is safeInvalidate's own concern.
vi.mock("$lib/chat/utils/safeInvalidate", () => ({ safeInvalidate: vi.fn(async () => {}) }));

// $app/state's `page` doesn't exist outside a real SvelteKit router either, same reason as above —
// but +page.server.ts's managedInferenceEnabled (CUR-1266+) rides page.data, which this component
// reads directly, so it needs a real (if bare) object rather than the blanket safeInvalidate-style
// mock. `vi.hoisted` so tests can mutate `mockPageData` after this factory has already run — plain
// module state, not a Svelte $state proxy, which is fine since every test calls render(Page) fresh
// rather than mutating this mid-render.
const mockPageData = vi.hoisted(() => ({ data: { managedInferenceEnabled: false } }));
vi.mock("$app/state", () => ({ page: mockPageData }));

// $lib/chat/APIClient unconditionally imports bson-objectid at module scope (for its ObjectId <->
// string superjson transformer) — a CJS package this project's client vitest config can't pre-bundle
// (optimizeDeps.noDiscovery/include:[] in vite.config.ts, set deliberately narrow; see
// BackgroundGenerationPoller.svelte.test.ts's own header comment for the same
// constraint). Any import of the real module — even just for handleResponse/ApiError — hits
// the same failure, since it's the file's own top-level code that throws, not anything this test
// calls. Faithfully reimplemented rather than stubbed to a no-op: this test's whole point is proving
// the component calls the right endpoint with the right method/body, which a no-op can't show.
vi.mock("$lib/chat/APIClient", () => {
	class ApiError extends Error {
		status: number;
		constructor(status: number, body: unknown) {
			super(JSON.stringify(body));
			this.status = status;
		}
	}

	async function req(url: string, method: string, body?: unknown) {
		const init: RequestInit = { method };
		if (body !== undefined) {
			init.headers = { "Content-Type": "application/json" };
			init.body = JSON.stringify(body);
		}
		const res = await fetch(url, init);
		const text = await res.text();
		if (!res.ok) {
			let errorBody: unknown;
			try {
				errorBody = JSON.parse(text);
			} catch {
				errorBody = text;
			}
			return { data: null, error: errorBody, status: res.status };
		}
		return { data: text || null, error: null, status: res.status };
	}

	function endpoint(url: string) {
		return {
			get: () => req(url, "GET"),
			post: (body?: unknown) => req(url, "POST", body),
			delete: () => req(url, "DELETE"),
		};
	}

	function useAPIClient() {
		const collectionUrl = "/chat/api/v2/user/local-inference-endpoints";
		return {
			user: {
				"local-inference-endpoints": Object.assign(
					(params: { id: string }) => endpoint(`${collectionUrl}/${params.id}`),
					endpoint(collectionUrl),
					{
						managed: Object.assign(endpoint(`${collectionUrl}/managed`), {
							availability: endpoint(`${collectionUrl}/managed/availability`),
						}),
					}
				),
			},
		};
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function handleResponse(response: { data: unknown; error: unknown; status: number }): any {
		if (response.error) throw new ApiError(response.status, response.error);
		if (response.data === null) return null;
		return superjson.parse(
			typeof response.data === "string" ? response.data : JSON.stringify(response.data)
		);
	}

	// The page reads apiErrorMessage from APIClient now; same unwrap as the real one. (CUR-2822)
	function apiErrorMessage(err: unknown, fallback: string): string {
		if (err instanceof ApiError) {
			try {
				const body = JSON.parse(err.message) as { message?: unknown };
				if (typeof body?.message === "string" && body.message) return body.message;
			} catch {
				// fall through to fallback
			}
		}
		return fallback;
	}

	return { useAPIClient, handleResponse, ApiError, apiErrorMessage };
});

import { safeInvalidate } from "$lib/chat/utils/safeInvalidate";
import Page from "./+page.svelte";

type Row = {
	id: string;
	label: string;
	baseUrl: string;
	headers: { name: string; value: string }[];
	createdAt: string;
};

/** A success payload — superjsonResponse's real wire shape (superjsonResponse.ts). */
function jsonResponse(status: number, data: unknown): Response {
	return new Response(superjson.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** An error payload — SvelteKit's own error(status, message) shape, which is PLAIN JSON
 *  ({"message": "..."}), never superjson: the framework maps the thrown error to a response before
 *  superjsonResponse ever runs, so an error body must not be encoded the same way a success body is. */
function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ message }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// A real in-memory fake of api/v2/user/local-inference-endpoints — this test's whole point is proving
// the COMPONENT wires fetch → render correctly; the real server route (validation, normalization,
// ownership) already has its own spec (api/__tests__/localInferenceEndpoints.spec.ts). Deliberately
// does NOT normalize baseUrl here, unlike the real route — asserting the raw value round-trips proves
// the component displays exactly what the server returns, without this fake quietly duplicating
// (and potentially drifting from) the real route's own normalization logic.
describe("Local Inference settings tab — add/remove wiring (CUR-1262)", () => {
	let rows: Row[];
	let nextId: number;
	let originalFetch: typeof globalThis.fetch;
	// Captures the last create request's raw body so tests can assert on exactly what the
	// component sent, not just what the fake server echoed back. (CUR-1291)
	let lastCreateBody: { label: string; baseUrl: string; headers?: { name: string; value: string }[] } | null;
	// Controls what GET .../managed/availability answers — the live Pangolin-reachability
	// half of the managed-server gate, separate from mockPageData's deployment-level on/off. (CUR-1266)
	let managedAvailable: boolean;
	// What the managed pair request carried, so a test can see the shared advanced-options
	// headers actually ride along with it. (CUR-3168)
	let lastManagedBody: { label: string; headers?: { name: string; value: string }[] } | null;

	beforeEach(() => {
		rows = [];
		nextId = 1;
		lastCreateBody = null;
		managedAvailable = true;
		lastManagedBody = null;
		mockPageData.data.managedInferenceEnabled = false;
		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
			const method = init?.method ?? "GET";

			if (url.pathname.endsWith("/user/local-inference-endpoints/managed/availability") && method === "GET") {
				return jsonResponse(200, { available: managedAvailable });
			}
			if (url.pathname.endsWith("/user/local-inference-endpoints/managed") && method === "POST") {
				lastManagedBody = JSON.parse(init?.body as string);
				return jsonResponse(201, {
					id: `row-${nextId++}`,
					label: lastManagedBody!.label,
					installArgs: { tunnelId: "t", tunnelSecret: "s", tunnelEndpoint: "https://e" },
				});
			}
			if (url.pathname.endsWith("/user/local-inference-endpoints") && method === "GET") {
				return jsonResponse(200, rows);
			}
			if (url.pathname.endsWith("/user/local-inference-endpoints") && method === "POST") {
				const body = JSON.parse(init?.body as string) as {
					label: string;
					baseUrl: string;
					headers?: { name: string; value: string }[];
				};
				lastCreateBody = body;
				if (!body.label || !body.baseUrl) {
					return errorResponse(400, "Name and Server URL are required");
				}
				const row: Row = {
					id: `row-${nextId++}`,
					label: body.label,
					baseUrl: body.baseUrl,
					headers: body.headers ?? [],
					createdAt: new Date(0).toISOString(),
				};
				rows = [...rows, row];
				return jsonResponse(201, row);
			}
			const deleteMatch = url.pathname.match(/\/user\/local-inference-endpoints\/([^/]+)$/);
			if (deleteMatch && method === "DELETE") {
				const id = deleteMatch[1];
				const existed = rows.some((r) => r.id === id);
				rows = rows.filter((r) => r.id !== id);
				return existed ? jsonResponse(200, { success: true }) : errorResponse(404, "Not found");
			}
			throw new Error(`Unhandled fetch in test: ${method} ${url.pathname}`);
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		cleanup();
		globalThis.fetch = originalFetch;
		vi.mocked(safeInvalidate).mockClear();
	});

	it("loads an empty list on mount", async () => {
		await render(Page);
		await expect.element(page.getByText("No local servers yet.")).toBeInTheDocument();
	});

	it("adds a server: it appears in the list and app:models is invalidated", async () => {
		await render(Page);
		await expect.element(page.getByText("No local servers yet.")).toBeInTheDocument();

		await page.getByPlaceholder("Workstation").fill("My workstation");
		await page.getByPlaceholder("http://localhost:11434").fill("http://192.168.1.50:11434/v1");
		await page.getByRole("button", { name: "Add server" }).click();

		await expect.element(page.getByText("My workstation")).toBeInTheDocument();
		await expect.element(page.getByText("http://192.168.1.50:11434/v1")).toBeInTheDocument();
		expect(page.getByText("No local servers yet.").query()).toBeNull();
		expect(safeInvalidate).toHaveBeenCalledWith("app:models");

		// Inputs clear for the next entry.
		await expect.element(page.getByPlaceholder("Workstation")).toHaveValue("");
	});

	it("adding a second server keeps the first — the settings UI is a real list, not one-per-user", async () => {
		await render(Page);

		await page.getByPlaceholder("Workstation").fill("Workstation");
		await page.getByPlaceholder("http://localhost:11434").fill("http://192.168.1.50:11434/v1");
		await page.getByRole("button", { name: "Add server" }).click();
		await expect.element(page.getByText("Workstation")).toBeInTheDocument();

		await page.getByPlaceholder("Workstation").fill("MacBook local");
		await page.getByPlaceholder("http://localhost:11434").fill("http://localhost:8080/v1");
		await page.getByRole("button", { name: "Add server" }).click();

		await expect.element(page.getByText("MacBook local")).toBeInTheDocument();
		await expect.element(page.getByText("Workstation")).toBeInTheDocument();
	});

	it("removes a server: it disappears and the empty state returns once the list is empty again", async () => {
		await render(Page);

		await page.getByPlaceholder("Workstation").fill("My workstation");
		await page.getByPlaceholder("http://localhost:11434").fill("http://192.168.1.50:11434/v1");
		await page.getByRole("button", { name: "Add server" }).click();
		await expect.element(page.getByText("My workstation")).toBeInTheDocument();

		await page.getByRole("button", { name: "Remove My workstation" }).click();

		await expect.element(page.getByText("No local servers yet.")).toBeInTheDocument();
		expect(page.getByText("My workstation").query()).toBeNull();
		expect(safeInvalidate).toHaveBeenCalledWith("app:models");
	});

	it("the Add button stays disabled until both fields have content", async () => {
		await render(Page);

		const addButton = page.getByRole("button", { name: "Add server" });
		await expect.element(addButton).toBeDisabled();

		await page.getByPlaceholder("Workstation").fill("Only a name");
		await expect.element(addButton).toBeDisabled();

		await page.getByPlaceholder("http://localhost:11434").fill("http://192.168.1.50:11434/v1");
		await expect.element(addButton).not.toBeDisabled();
	});

	it("shows a real error message (not raw JSON) when the server rejects the add", async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
			const method = init?.method ?? "GET";
			if (url.pathname.endsWith("/user/local-inference-endpoints") && method === "GET") {
				return jsonResponse(200, []);
			}
			if (url.pathname.endsWith("/user/local-inference-endpoints") && method === "POST") {
				return errorResponse(400, "Enter a valid server URL, e.g. http://localhost:11434");
			}
			throw new Error(`Unhandled fetch in test: ${method} ${url.pathname}`);
		}) as typeof globalThis.fetch;

		await render(Page);
		await page.getByPlaceholder("Workstation").fill("Bad server");
		await page.getByPlaceholder("http://localhost:11434").fill("not a url");
		await page.getByRole("button", { name: "Add server" }).click();

		await expect
			.element(page.getByText("Enter a valid server URL, e.g. http://localhost:11434"))
			.toBeInTheDocument();
		// Never falls back to showing the raw ApiError JSON blob.
		expect(page.getByText('{"message":').query()).toBeNull();
	});

	// The Advanced Options rollup + custom-headers form (design: "Local Inference Settings
	// Tab", Advanced Options revision). Local component state only — no DB column or wire application
	// exists yet (see the HeaderRow doc comment in +page.svelte), so these tests cover the UI's own
	// behavior (toggle, add, remove, reset-on-submit) rather than anything reaching the network. (CUR-1291)
	describe("Advanced Options — custom headers (local-only, CUR-1291)", () => {
		it("the panel is collapsed by default and expands on toggle", async () => {
			await render(Page);

			expect(page.getByPlaceholder("Authorization").query()).toBeNull();

			await page.getByRole("button", { name: "Advanced Options" }).click();
			await expect.element(page.getByPlaceholder("Authorization")).toBeInTheDocument();
			await expect.element(page.getByPlaceholder("Bearer …")).toBeInTheDocument();

			await page.getByRole("button", { name: "Advanced Options" }).click();
			expect(page.getByPlaceholder("Authorization").query()).toBeNull();
		});

		it("the Add custom header button stays disabled until a header name is entered", async () => {
			await render(Page);
			await page.getByRole("button", { name: "Advanced Options" }).click();

			const addHeaderButton = page.getByRole("button", { name: "Add custom header" });
			await expect.element(addHeaderButton).toBeDisabled();

			await page.getByPlaceholder("Bearer …").fill("some-value-with-no-name");
			await expect.element(addHeaderButton).toBeDisabled();

			await page.getByPlaceholder("Authorization").fill("Authorization");
			await expect.element(addHeaderButton).not.toBeDisabled();
		});

		it("adds a header (value optional) and removes it again", async () => {
			await render(Page);
			await page.getByRole("button", { name: "Advanced Options" }).click();

			await page.getByPlaceholder("Authorization").fill("Authorization");
			await page.getByPlaceholder("Bearer …").fill("Bearer super-secret");
			await page.getByRole("button", { name: "Add custom header" }).click();

			await expect.element(page.getByText("Authorization")).toBeInTheDocument();
			await expect.element(page.getByText("Bearer super-secret")).toBeInTheDocument();
			// Inputs clear for the next header, same idiom as the server form.
			await expect.element(page.getByPlaceholder("Authorization")).toHaveValue("");

			// A second header with no value is valid — only the name is required.
			await page.getByPlaceholder("Authorization").fill("X-Custom-Flag");
			await page.getByRole("button", { name: "Add custom header" }).click();
			await expect.element(page.getByText("X-Custom-Flag")).toBeInTheDocument();

			await page.getByRole("button", { name: "Remove header Authorization" }).click();
			expect(page.getByText("Bearer super-secret").query()).toBeNull();
			await expect.element(page.getByText("X-Custom-Flag")).toBeInTheDocument();
		});

		it("sends the entered custom headers in the create request, then clears the form", async () => {
			await render(Page);
			await page.getByRole("button", { name: "Advanced Options" }).click();
			await page.getByPlaceholder("Authorization").fill("Authorization");
			await page.getByPlaceholder("Bearer …").fill("Bearer super-secret");
			await page.getByRole("button", { name: "Add custom header" }).click();
			await page.getByPlaceholder("Authorization").fill("X-Custom-Flag");
			await page.getByRole("button", { name: "Add custom header" }).click();
			await expect.element(page.getByText("Authorization")).toBeInTheDocument();

			await page.getByPlaceholder("Workstation").fill("My workstation");
			await page.getByPlaceholder("http://localhost:11434").fill("http://192.168.1.50:11434/v1");
			await page.getByRole("button", { name: "Add server" }).click();

			await expect.element(page.getByText("My workstation")).toBeInTheDocument();
			expect(lastCreateBody?.headers).toEqual([
				{ name: "Authorization", value: "Bearer super-secret" },
				{ name: "X-Custom-Flag", value: "" },
			]);
			// The just-created server's headers belong to it, not to whatever's added next.
			expect(page.getByText("Authorization").query()).toBeNull();
		});

		it("sends an empty headers array when none were entered", async () => {
			await render(Page);
			await page.getByPlaceholder("Workstation").fill("No headers");
			await page.getByPlaceholder("http://localhost:11434").fill("http://192.168.1.50:11434/v1");
			await page.getByRole("button", { name: "Add server" }).click();

			await expect.element(page.getByText("No headers")).toBeInTheDocument();
			expect(lastCreateBody?.headers).toEqual([]);
		});
	});

	// managedLocalInferenceEndpointsEnabled() (page.data.managedInferenceEnabled, the
	// deployment-wide flag) and Pangolin reachability (GET .../managed/availability, live) are two
	// separate signals on purpose — see managedInferenceGate.ts's header. The first controls whether
	// this whole section exists; the second only disables the Pair control within it. (CUR-1266)
	// The name + Pair form lives under the "Pair a server manually" disclosure now. (CUR-1324)
	async function openManualPair() {
		await page.getByRole("button", { name: "Pair a server manually" }).click();
	}

	describe("Managed servers — flag split (CUR-1266+)", () => {
		it("hides the whole 'Add a managed server' section when the deployment flag is off", async () => {
			mockPageData.data.managedInferenceEnabled = false;
			await render(Page);

			await expect.element(page.getByText("No local servers yet.")).toBeInTheDocument();
			expect(page.getByText("Add a managed server").query()).toBeNull();
		});

		it("shows the section but disables Pair + the name field, with a tooltip, while Pangolin is unavailable", async () => {
			mockPageData.data.managedInferenceEnabled = true;
			managedAvailable = false;
			await render(Page);

			await expect.element(page.getByText("Add a managed server")).toBeInTheDocument();
			await openManualPair();
			const nameInput = page.getByPlaceholder("Living room PC");
			const pairButton = page.getByRole("button", { name: "Pair", exact: true });

			await expect.element(nameInput).toBeDisabled();
			await expect.element(pairButton).toBeDisabled();
			// Disabled is already true during the in-flight "Checking…" state too (same as the resolved
			// "unavailable" state) — poll the tooltip text itself, which only reaches its final wording
			// once the availability fetch actually resolves, rather than a synchronous read that can
			// race the promise.
			await expect.poll(() => nameInput.element().getAttribute("title")).toMatch(/unavailable/i);
			await expect.poll(() => pairButton.element().getAttribute("title")).toMatch(/unavailable/i);
		});

		it("enables Pair + the name field once Pangolin reports available", async () => {
			mockPageData.data.managedInferenceEnabled = true;
			managedAvailable = true;
			await render(Page);
			await openManualPair();

			const nameInput = page.getByPlaceholder("Living room PC");
			await expect.element(nameInput).not.toBeDisabled();
			expect(nameInput.element().getAttribute("title")).toBeNull();
			// The button itself is still disabled until a name is entered (existing wiring) — the
			// availability gate specifically is what this test is pinning down.
			await page.getByPlaceholder("Living room PC").fill("Living room PC");
			await expect.element(page.getByRole("button", { name: "Pair", exact: true })).not.toBeDisabled();
		});
	});

	describe("layout and shared options (CUR-3168)", () => {
			// The managed flow is the one being promoted, so these run with it switched on. Nested inside
			// the suite above on purpose: that one installs the fetch mock, and anything touching the
			// availability poll is silently disabled without it.
			beforeEach(() => {
				mockPageData.data.managedInferenceEnabled = true;
			});

		it("offers the managed server above the manual one", async () => {
			// The point of the reorder: a reader meets the easier path first. Compared by document
			// position rather than by reading the markup, so a future refactor that moves the blocks
			// still has to keep the order a person actually sees.
			await render(Page);
			const managed = page.getByText("Add a managed server").element();
			const manual = page.getByText("Add a direct server connection").element();
			expect(managed.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		});

		it("still offers the manual form when managed servers are switched off", async () => {
			// Regression guard: the manual block must not sit inside the managed
			// {#if}, which balances as markup and would silently remove the only way to add a server on a
			// deployment without Pangolin.
			mockPageData.data.managedInferenceEnabled = false;
			await render(Page);
			await expect.element(page.getByText("Add a direct server connection")).toBeInTheDocument();
			expect(page.getByText("Add a managed server").query()).toBeNull();
		});

		it("keeps saying the manual server has to be reachable directly", async () => {
			// The note states that constraint: it is the whole reason someone would
			// choose the managed flow instead, so losing it would make the choice unexplainable.
			await render(Page);
			await expect.element(page.getByText(/reach directly/i)).toBeInTheDocument();
		});

		it("starts the managed name filled in, so the field is a thing to accept", async () => {
			await render(Page);
			await openManualPair();
			// The placeholder still identifies the field even though a value now hides it.
			const input = page.getByPlaceholder("Living room PC").element() as HTMLInputElement;
			expect(input.value.trim().length).toBeGreaterThan(0);
		});

		it("carries the shared advanced-options headers into a managed pair", async () => {
			// The substance of "shared": the advanced box serves the managed pair as well as the manual form, so a
			// managed endpoint can carry a custom header.
			await render(Page);
			await openManualPair();
			// The Pair control stays disabled until the availability poll answers, so wait for it rather
			// than racing it.
			await expect
				.poll(() => (page.getByRole("button", { name: "Pair", exact: true }).element() as HTMLButtonElement).disabled)
				.toBe(false);
			await page.getByRole("button", { name: "Advanced Options" }).click();
			await page.getByPlaceholder("Authorization").fill("X-Tenant");
			await page.getByPlaceholder("Bearer …").fill("acme");
			await page.getByRole("button", { name: "Add custom header" }).click();
			await page.getByRole("button", { name: "Pair", exact: true }).click();

			await expect.poll(() => lastManagedBody?.headers).toEqual([{ name: "X-Tenant", value: "acme" }]);
		});
	});


		describe("the install-first managed card (CUR-1324)", () => {
			beforeEach(() => {
				mockPageData.data.managedInferenceEnabled = true;
			});

			it("shows the install picker before anything is paired, with no step numbers", async () => {
				await render(Page);
				await expect.element(page.getByText("Install aipotluck-local-client on that machine")).toBeInTheDocument();
				await expect.element(page.getByRole("link", { name: /Download x64 · \.deb for Linux/ })).toBeInTheDocument();
				expect(page.getByText("2. Pair it").query()).toBeNull();
			});

			it("folds the manual name + Pair form away until asked for", async () => {
				await render(Page);
				const toggle = page.getByRole("button", { name: "Pair a server manually" });
				await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
				expect(page.getByPlaceholder("Living room PC").query()).toBeNull();
				expect(page.getByRole("button", { name: "Pair", exact: true }).query()).toBeNull();

				await toggle.click();
				await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
				await expect.element(page.getByPlaceholder("Living room PC")).toBeInTheDocument();
			});

			it("puts the install picker above the manual pair disclosure", async () => {
				// Compared by document position, like the managed-above-manual test: the main path is
				// what a reader meets first.
				await render(Page);
				const install = page.getByText("Install aipotluck-local-client on that machine").element();
				const manual = page.getByRole("button", { name: "Pair a server manually" }).element();
				expect(install.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			});

			it("tells a command-line install to run `aipotluck-local-client login`", async () => {
				await render(Page);
				await page.getByRole("tab", { name: "Command line" }).click();
				const step = page.getByTestId("local-login-step");
				await expect.element(step).toHaveTextContent(/run aipotluck-local-client login on that machine/);
			});

			it("tells an app install to download and run the installer", async () => {
				await render(Page);
				await page.getByRole("tab", { name: "App" }).click();
				await expect
					.element(page.getByTestId("local-login-step"))
					.toHaveTextContent(/Download and run the installer on that machine/);
			});

			it("never tells someone to run a build that doesn't exist", async () => {
				// iOS has no app build yet: the no-build note stands alone, with no install instruction.
				await render(Page);
				await page.getByRole("tab", { name: "iOS" }).click();
				await expect.element(page.getByText(/no app build/)).toBeInTheDocument();
				expect(page.getByTestId("local-login-step").query()).toBeNull();
			});

			it("after a manual pair, shows the credentials once with the --credentials-file instruction", async () => {
				await render(Page);
				await openManualPair();
				await expect
					.poll(() => (page.getByRole("button", { name: "Pair", exact: true }).element() as HTMLButtonElement).disabled)
					.toBe(false);
				await page.getByRole("button", { name: "Pair", exact: true }).click();

				await expect.element(page.getByText("Credentials", { exact: true })).toBeInTheDocument();
				await expect.element(page.getByText(/--credentials-file/)).toBeInTheDocument();
			});
		});

		describe("the install step's platform picker (CUR-3168)", () => {
			// The install step only renders inside the managed block, so these need it switched on.
			beforeEach(() => {
				mockPageData.data.managedInferenceEnabled = true;
			});

			// The picker is the card's main path now, shown before any pair. (CUR-1324)
			async function pair() {
				await render(Page);
				await expect.element(page.getByText("Install aipotluck-local-client on that machine")).toBeInTheDocument();
			}

			it("opens on the app, the path the card leads with", async () => {
				// An app build ships for every desktop platform, so the picker opens on it
				// rather than on the command line. (CUR-1324)
				await pair();
				await expect.element(page.getByRole("tab", { name: "App" })).toHaveAttribute("aria-selected", "true");
				await expect.element(page.getByText(/Download this on that machine/)).toBeInTheDocument();
				expect(page.getByText(/curl -fsSL/).query()).toBeNull();
			});

			it("gives Linux + command line the install command and a copy control", async () => {
				await pair();
				await page.getByRole("tab", { name: "Command line" }).click();

				await expect.element(page.getByText(/curl -fsSL .*aipotluck-local-client\/main\/install\.sh \| bash/)).toBeInTheDocument();
				await expect.element(page.getByText(/Run this in a terminal/)).toBeInTheDocument();
			});

			it("gives macOS + command line the same install.sh command", async () => {
				await pair();
				await page.getByRole("tab", { name: "macOS" }).click();
				await page.getByRole("tab", { name: "Command line" }).click();
				await expect.element(page.getByText(/curl -fsSL .*\/install\.sh \| bash/)).toBeInTheDocument();
			});

			it("gives Windows + command line the PowerShell install.ps1 command, not the bash one", async () => {
				await pair();
				await page.getByRole("tab", { name: "Windows" }).click();
				await page.getByRole("tab", { name: "Command line" }).click();
				await expect.element(page.getByText(/irm .*aipotluck-local-client\/main\/install\.ps1 \| iex/)).toBeInTheDocument();
				expect(page.getByText(/curl -fsSL/).query()).toBeNull();
			});

			// Every fixed "latest" name, on the tab for its platform. Checked as the link's
			// accessible name and its href, so a link pointing at the wrong platform's file fails. These
			// names are the GUI repo's contract (.github/latest-download-names.txt there); change them only
			// as docs/guides/local-client-downloads.md says. (CUR-4416)
			const RELEASE = "https://github.com/currentai-org/aipotluck-local-client-gui/releases/latest/download/aipotluck-local-client-gui_";
			const RELEASE_FILES: [string, string, string][] = [
				["Linux", "x64 · .deb", "linux-x64.deb"],
				["Linux", "x64 · .AppImage", "linux-x64.AppImage"],
				["Linux", "ARM64 · .deb", "linux-arm64.deb"],
				["Linux", "ARM64 · .AppImage", "linux-arm64.AppImage"],
				["macOS", "Apple silicon · .dmg", "macos-arm64.dmg"],
				["macOS", "Apple silicon · .app.zip", "macos-arm64.app.zip"],
				["macOS", "Intel · .dmg", "macos-x64.dmg"],
				["macOS", "Intel · .app.zip", "macos-x64.app.zip"],
				["Windows", "x64 · installer (.exe)", "windows-x64.setup.exe"],
			];

			it.each(["Linux", "macOS", "Windows"])("links every fixed latest-release file for %s, and only those, on its App tab", async (platformName) => {
				await pair();
				await page.getByRole("tab", { name: platformName }).click();
				await page.getByRole("tab", { name: "App" }).click();

				const expected = RELEASE_FILES.filter(([p]) => p === platformName);
				for (const [, label, file] of expected) {
					const link = page.getByRole("link", { name: `Download ${label} for ${platformName}` });
					await expect.element(link).toHaveAttribute("href", RELEASE + file);
				}
				const shown = [...document.querySelectorAll('a[href^="https://github.com/currentai-org/aipotluck-local-client-gui/"]')];
				expect(shown).toHaveLength(expected.length);
			});

			it("says which combination is missing rather than showing an empty panel", async () => {
				// Someone checking whether their platform is coming needs a straight answer. Matched on
				// the sentence, not the "Unavailable" word alone — that sits in its own <span> inside the
				// paragraph, so a bare /Unavailable/ matches two nested elements and resolves to neither.
				await pair();
				await page.getByRole("tab", { name: "Android" }).click();

				await expect.element(page.getByText(/no app build/)).toBeInTheDocument();
				expect(page.getByRole("link", { name: /^Download / }).query()).toBeNull();
			});

			it("will not put a phone on the command-line build", async () => {
				// Asserted as behaviour rather than as an attribute: what matters is that a phone cannot
				// end up on a command it has no terminal to run, not which flag the tab engine uses to
				// mark the control dead.
				await pair();
				await page.getByRole("tab", { name: "Command line" }).click();
				await expect.element(page.getByText(/curl -fsSL/)).toBeInTheDocument();

				await page.getByRole("tab", { name: "Android" }).click();

				await expect.element(page.getByText(/no app build/)).toBeInTheDocument();
				expect(page.getByText(/curl -fsSL/).query()).toBeNull();
				expect(page.getByText(/Run this in a terminal/).query()).toBeNull();
			});

			it("restores the command-line pick when leaving the phone again", async () => {
				// The phone forces GUI for as long as it is selected; it must not quietly rewrite a
				// preference the person set for their desktop.
				await pair();
				await page.getByRole("tab", { name: "Command line" }).click();
				await page.getByRole("tab", { name: "iOS" }).click();
				await page.getByRole("tab", { name: "Linux" }).click();

				await expect.element(page.getByText(/curl -fsSL/)).toBeInTheDocument();
			});
		});

});
