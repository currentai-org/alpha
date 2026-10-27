<script lang="ts">
	// The multi-provider sign-in chooser (CUR-434, CUR-482). Email leads, then Google/GitHub/Hugging
	// Face as a secondary "OR" group so no single company is the only way in, then passkey last
	// (CUR-608): a passkey button can only sign in against a credential that already exists, so for a
	// new user it is a dead end and would read as broken at the top of the list.
	//
	// Icon paths below are copied verbatim from the installed `remixicon` package (google-line,
	// github-line, mail-line, fingerprint-line, all Logos/Business/Device — 24x24, single <path>,
	// fill="currentColor" per design-system.md § Iconography). Hugging Face has no Remix Icon glyph —
	// it's a brand mark, not a general UI icon, and Remix Icon's "Logos" set only covers the handful of
	// services common enough to warrant one (Google, GitHub, a few others). `robot-line` stands in
	// rather than hand-drawing HF's actual trademarked logo from memory, which risks getting it wrong.
	import type { PageData } from "./$types";
	import { onMount, tick } from "svelte";
	import { replaceState } from "$app/navigation";
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import { authClient, passkeyOptionsSettled } from "$lib/chat/authClient";
	import { APP_NAME } from "$lib/chat/constants/app";
	import { friendlyAuthErrorMessage, friendlyPasskeyError } from "$lib/chat/authErrorMessages";
	// The only way to interrupt an in-flight passkey ceremony (navigator.credentials.get())
	// is SimpleWebAuthn's own abort singleton — startAuthentication() (called inside Better Auth's
	// passkeyClient()) always requests a fresh AbortSignal from this service before calling
	// navigator.credentials.get(), so cancelCeremony() here reaches the exact in-flight call. Better
	// Auth's passkey client doesn't expose a signal/cancel option of its own (checked
	// @better-auth/passkey's dist/client.mjs), so there's no way to reach this except directly. (CUR-1064)
	import { WebAuthnAbortService } from "@simplewebauthn/browser";
	import { Button, Input, Spinner } from "@aipotluck/alpha-ds";
	import SignInHero from "$lib/chat/components/SignInHero.svelte";
	import RiCloseLine from "~icons/ri/close-line";

	let { data }: { data: PageData } = $props();

	type Phase = "chooser" | "otp-code";
	let phase = $state<Phase>("chooser");
	let email = $state("");
	let otp = $state("");
	let busy = $state<string | null>(null);
	let errorMsg = $state("");

	// The routes after email, passkey always among them: four sit as a 2×2 grid, three in one row.
	const alternateCount = $derived(
		1 + [data.providers.google, data.providers.github, data.providers.huggingface].filter(Boolean).length
	);
	// The providers this deployment offers, by the names the buttons use, for the passkey failure copy.
	const offeredProviders = $derived(
		([["google", "Google"], ["github", "GitHub"], ["huggingface", "Hugging Face"]] as const)
			.filter(([key]) => data.providers[key])
			.map(([, name]) => name)
	);
	const alternateColumns = $derived(alternateCount === 3 ? "sm:grid-cols-3" : alternateCount > 1 ? "sm:grid-cols-2" : "");

	// Both forms' onsubmit is a property Svelte attaches at hydration. A click landing on the
	// submit button before hydration completes falls through to the browser's own default form
	// submission. Neither input carries `name`, so that native submit is a GET with an empty query: it
	// silently discards whatever was typed and reloads this same page. Gating each submit button's
	// `disabled` on this flag removes it as the form's activatable default button during that window,
	// which blocks both a direct click and an implicit Enter-key submission. (CUR-1400)
	let hydrated = $state(false);

	const ICONS = {
		google:
			"M12 11H20.5329C20.5769 11.3847 20.6 11.7792 20.6 12.1837C20.6 14.9184 19.6204 17.2204 17.9224 18.7837C16.4367 20.1551 14.404 20.9592 11.9796 20.9592C8.46933 20.9592 5.43266 18.947 3.9551 16.0123C3.34695 14.8 3 13.4286 3 11.9796C3 10.5306 3.34695 9.1592 3.9551 7.94698C5.43266 5.01226 8.46933 3 11.9796 3C14.4 3 16.4326 3.88983 17.9877 5.33878L16.5255 6.80101C15.3682 5.68153 13.8028 5 12 5C8.13401 5 5 8.13401 5 12C5 15.866 8.13401 19 12 19C15.5265 19 18.1443 16.3923 18.577 13H12V11Z",
		github:
			"M5.88401 18.6533C5.58404 18.4526 5.32587 18.1975 5.0239 17.8369C4.91473 17.7065 4.47283 17.1524 4.55811 17.2583C4.09533 16.6833 3.80296 16.417 3.50156 16.3089C2.9817 16.1225 2.7114 15.5499 2.89784 15.0301C3.08428 14.5102 3.65685 14.2399 4.17672 14.4263C4.92936 14.6963 5.43847 15.1611 6.12425 16.0143C6.03025 15.8974 6.46364 16.441 6.55731 16.5529C6.74784 16.7804 6.88732 16.9182 6.99629 16.9911C7.20118 17.1283 7.58451 17.1874 8.14709 17.1311C8.17065 16.7489 8.24136 16.3783 8.34919 16.0358C5.38097 15.3104 3.70116 13.3952 3.70116 9.63971C3.70116 8.40085 4.0704 7.28393 4.75917 6.3478C4.5415 5.45392 4.57433 4.37284 5.06092 3.15636C5.1725 2.87739 5.40361 2.66338 5.69031 2.57352C5.77242 2.54973 5.81791 2.53915 5.89878 2.52673C6.70167 2.40343 7.83573 2.69705 9.31449 3.62336C10.181 3.41879 11.0885 3.315 12.0012 3.315C12.9129 3.315 13.8196 3.4186 14.6854 3.62277C16.1619 2.69 17.2986 2.39649 18.1072 2.52651C18.1919 2.54013 18.2645 2.55783 18.3249 2.57766C18.6059 2.66991 18.8316 2.88179 18.9414 3.15636C19.4279 4.37256 19.4608 5.45344 19.2433 6.3472C19.9342 7.28337 20.3012 8.39208 20.3012 9.63971C20.3012 13.3968 18.627 15.3048 15.6588 16.032C15.7837 16.447 15.8496 16.9105 15.8496 17.4121C15.8496 18.0765 15.8471 18.711 15.8424 19.4225C15.8412 19.6127 15.8397 19.8159 15.8375 20.1281C16.2129 20.2109 16.5229 20.5077 16.6031 20.9089C16.7114 21.4504 16.3602 21.9773 15.8186 22.0856C14.6794 22.3134 13.8353 21.5538 13.8353 20.5611C13.8353 20.4708 13.836 20.3417 13.8375 20.1145C13.8398 19.8015 13.8412 19.599 13.8425 19.4094C13.8471 18.7019 13.8496 18.0716 13.8496 17.4121C13.8496 16.7148 13.6664 16.2602 13.4237 16.051C12.7627 15.4812 13.0977 14.3973 13.965 14.2999C16.9314 13.9666 18.3012 12.8177 18.3012 9.63971C18.3012 8.68508 17.9893 7.89571 17.3881 7.23559C17.1301 6.95233 17.0567 6.54659 17.199 6.19087C17.3647 5.77663 17.4354 5.23384 17.2941 4.57702L17.2847 4.57968C16.7928 4.71886 16.1744 5.0198 15.4261 5.5285C15.182 5.69438 14.8772 5.74401 14.5932 5.66413C13.7729 5.43343 12.8913 5.315 12.0012 5.315C11.111 5.315 10.2294 5.43343 9.40916 5.66413C9.12662 5.74359 8.82344 5.69492 8.57997 5.53101C7.8274 5.02439 7.2056 4.72379 6.71079 4.58376C6.56735 5.23696 6.63814 5.77782 6.80336 6.19087C6.94565 6.54659 6.87219 6.95233 6.61423 7.23559C6.01715 7.8912 5.70116 8.69376 5.70116 9.63971C5.70116 12.8116 7.07225 13.9683 10.023 14.2999C10.8883 14.3971 11.2246 15.4769 10.5675 16.0482C10.3751 16.2156 10.1384 16.7802 10.1384 17.4121V20.5611C10.1384 21.5474 9.30356 22.2869 8.17878 22.09C7.63476 21.9948 7.27093 21.4766 7.36613 20.9326C7.43827 20.5204 7.75331 20.2116 8.13841 20.1276V19.1381C7.22829 19.1994 6.47656 19.0498 5.88401 18.6533Z",
		robot:
			"M13 4.05493C17.5 4.55237 21 8.36745 21 13V22H3V13C3 8.36745 6.50005 4.55237 11 4.05493V1H13V4.05493ZM19 20V13C19 9.13401 15.866 6 12 6C8.13401 6 5 9.13401 5 13V20H19ZM12 18C9.23858 18 7 15.7614 7 13C7 10.2386 9.23858 8 12 8C14.7614 8 17 10.2386 17 13C17 15.7614 14.7614 18 12 18ZM12 16C13.6569 16 15 14.6569 15 13C15 11.3431 13.6569 10 12 10C10.3431 10 9 11.3431 9 13C9 14.6569 10.3431 16 12 16ZM12 14C11.4477 14 11 13.5523 11 13C11 12.4477 11.4477 12 12 12C12.5523 12 13 12.4477 13 13C13 13.5523 12.5523 14 12 14Z",
		mail: "M3 3H21C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3ZM20 7.23792L12.0718 14.338L4 7.21594V19H20V7.23792ZM4.51146 5L12.0619 11.662L19.501 5H4.51146Z",
		// Fill variant of the error icon, per design-system.md's icon rule ("destructive → Accent 2 ...
		// reserved for the most important, highest-stakes icons"). A plain-text errorMsg box read as a
		// second, duplicate email input rather than an error — same border/background as the field above
		// it, no color or icon to mark it as a problem (CUR-1064) — so the icon is colored via --ap-danger
		// (the design system's Accent 2 destructive color), on the icon only, never the surface or
		// border. Verbatim from @iconify-json/ri's error-warning-fill.
		errorWarning:
			"M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m-1-7v2h2v-2zm0-8v6h2V7z",
		fingerprint:
			"M17.0003 13V14C17.0003 16.7696 16.3364 19.445 15.0853 21.8455L14.8585 22.2663L13.1116 21.2924C14.2716 19.2115 14.9211 16.8817 14.9935 14.4559L15.0003 14V13H17.0003ZM11.0003 10H13.0003V14L12.9948 14.3787C12.9153 17.1495 11.9645 19.7731 10.3038 21.928L10.073 22.2189L8.52406 20.9536C10.0408 19.0969 10.9145 16.8017 10.9943 14.3663L11.0003 14V10ZM12.0003 6C14.7617 6 17.0003 8.23858 17.0003 11H15.0003C15.0003 9.34315 13.6571 8 12.0003 8C10.3434 8 9.00025 9.34315 9.00025 11V14C9.00025 16.2354 8.1806 18.3444 6.72928 19.9768L6.51767 20.2067L5.06955 18.8273C6.23328 17.6056 6.92099 16.0118 6.99381 14.3027L7.00025 14V11C7.00025 8.23858 9.23883 6 12.0003 6ZM12.0003 2C16.9708 2 21.0003 6.02944 21.0003 11V14C21.0003 15.6979 20.7985 17.3699 20.4035 18.9903L20.2647 19.5285L18.3349 19.0032C18.726 17.5662 18.9475 16.0808 18.9919 14.5684L19.0003 14V11C19.0003 7.13401 15.8662 4 12.0003 4C10.4279 4 8.97663 4.51841 7.80805 5.39364L6.38308 3.96769C7.92267 2.73631 9.87547 2 12.0003 2ZM4.96794 5.38282L6.39389 6.8078C5.5635 7.91652 5.0543 9.27971 5.00431 10.7593L4.99961 10.999L5.00378 13C5.00378 14.1195 4.73991 15.2026 4.24263 16.1772L4.08648 16.4663L2.34961 15.4747C2.72889 14.8103 2.95077 14.0681 2.99539 13.2924L3.00378 13L3.00361 11C3.00025 8.87522 3.73656 6.92242 4.96794 5.38282Z",
		arrowRight: "M12 4L10.59 5.41L16.17 11H4V13H16.17L10.59 18.59L12 20L20 12L12 4Z",
	};

	// Return to wherever the visitor was headed before sign-in — most commonly a workspace
	// invitation's accept page, whose own +page.server.ts redirects here with `next` set when the
	// visitor has no session yet. Dropping `next` lands a brand-new invitee on the bare app root with
	// no trace of the invitation they clicked, so their account is created but the invitation never
	// is (CUR-960).
	function afterSignIn() {
		window.location.href = data.next ?? `${base}/`;
	}

	async function withBusy(name: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = name;
		errorMsg = "";
		try {
			await fn();
		} finally {
			busy = null;
		}
	}

	function signInSocial(provider: "google" | "github" | "huggingface") {
		return withBusy(provider, async () => {
			const { error } = await authClient.signIn.social({
				provider,
				// Same `next` handling as afterSignIn(): an invited visitor who signs up via an OAuth provider
				// instead of email-OTP would otherwise lose it (CUR-960).
				callbackURL: data.next ?? `${base}/`,
				// Without this, a callback failure (most notably account_not_linked — see betterAuth.ts's
				// disableImplicitLinking) falls through to Better Auth's bare-root default (CUR-850). Round-trips
				// back here instead, where the ?error= handling below reads it. This `error` from signIn.social
				// itself only fires for a failure to START the redirect (e.g. no such provider) — the callback
				// failure arrives later, as a query param on this same round-trip. Carries `next` forward too, so
				// switching to a different sign-in method after a failed provider attempt keeps the invitation.
				errorCallbackURL: data.next
					? `${base}/login?next=${encodeURIComponent(data.next)}`
					: `${base}/login`,
			});
			if (error) errorMsg = error.message ?? `Couldn't start sign-in with ${provider}.`;
			else leavingFor = provider;
		});
	}

	// signIn.social resolves once it has set the provider's URL, before the browser leaves,
	// and withBusy then clears `busy`, so the button would go back to "Google" and take clicks for as long
	// as the provider takes to answer. This holds the redirecting state until the page is gone, and lets
	// it go if Back restores this page from the back-forward cache. (CUR-2739)
	let leavingFor = $state<"google" | "github" | "huggingface" | null>(null);
	$effect(() => {
		const restored = (e: PageTransitionEvent) => {
			if (e.persisted) leavingFor = null;
		};
		window.addEventListener("pageshow", restored);
		return () => window.removeEventListener("pageshow", restored);
	});

	// Set right before we abort so the resulting AUTH_CANCELLED result (Better Auth's
	// passkey client catches whatever navigator.credentials.get() throws and turns it into a normal
	// {error} return, never a rejection — see @better-auth/passkey's dist/client.mjs) reads as "back to
	// normal", not as a failure the user needs to react to. (CUR-1064)
	let passkeyCancelledByUser = false;

	function signInPasskey() {
		passkeyCancelledByUser = false;
		return withBusy("passkey", async () => {
			// Let the autofill ceremony reach the browser first, so this one aborts it rather
			// than racing it for the one challenge cookie. (CUR-2695)
			await passkeyOptionsSettled();
			const result = await authClient.signIn.passkey();
			if (result?.error) {
				if (!passkeyCancelledByUser) {
					errorMsg = friendlyPasskeyError(result.error, offeredProviders);
				}
				return;
			}
			afterSignIn();
		});
	}

	// The Cancel control below — only shown while busy === "passkey" — calls this directly rather than
	// going through withBusy, since withBusy's `if (busy) return` guard would make a second call a
	// no-op while the first is still in flight.
	function cancelPasskey() {
		passkeyCancelledByUser = true;
		WebAuthnAbortService.cancelCeremony();
	}

	// WebAuthn conditional UI — silently offers a matching passkey as browser autofill on
	// the email field below, no button, nothing shown if none exists. Must never touch errorMsg/busy:
	// the explicit passkey button above is the loud-failure path (CUR-608), this one stays quiet. (CUR-609)
	let passkeyAutofillTried = $state(false);
	async function signInPasskeyConditional() {
		const result = await authClient.signIn.passkey({ autoFill: true });
		if (result?.data) afterSignIn();
	}
	$effect(() => {
		if (phase === "chooser" && !passkeyAutofillTried) {
			passkeyAutofillTried = true;
			signInPasskeyConditional();
		}
	});

	// A callback failure round-trips back to this page via errorCallbackURL above (most notably
	// account_not_linked — see betterAuth.ts's disableImplicitLinking) instead of falling through to
	// Better Auth's bare-root default (CUR-850). Read the code once, show it, then strip the query
	// string so a refresh doesn't re-show a stale error — same pattern as account/+page.svelte.
	//
	// This arrival is a HARD browser navigation (the OAuth provider's own redirect back to
	// errorCallbackURL, not a SvelteKit client-side one), so the history entry to replace is one the
	// browser itself just created, on mount, with no user gesture involved. `goto(..., {replaceState:
	// true})` on such an entry risks back-button glitches, and it also runs a full client navigation
	// (re-invalidates load functions), which is more than this needs: nothing here is navigating
	// anywhere, only the query string is changing. `replaceState` (from `$app/navigation`, distinct
	// from `goto`'s `replaceState` option) is the narrower primitive SvelteKit ships for exactly
	// this — swap the URL/state in place with no navigation lifecycle at all — so use that instead
	// of routing a cosmetic query-string strip through the full navigator (CUR-1060).
	onMount(() => {
		hydrated = true;
		const errorCode = page.url.searchParams.get("error");
		if (errorCode) {
			errorMsg = friendlyAuthErrorMessage(errorCode);
			// Strip only `error`, not the whole query string — `next` (errorCallbackURL above carries it)
			// has to survive this so a retry after a failed OAuth attempt still knows where to return to
			// (CUR-960).
			const target = data.next ? `${page.url.pathname}?next=${encodeURIComponent(data.next)}` : page.url.pathname;
			// After a tick, not synchronously. onMount runs during hydration, before SvelteKit's router
			// holds its root component, and replaceState writes to that root, so a synchronous call throws
			// `reading '$set'` and the message above never renders. Same deferral as ChatLanding.svelte's
			// query-param strips (CUR-1813).
			tick().then(() => replaceState(target, page.state));
		}
	});

	// Better Auth's own error.message is its internal error-code text verbatim ("OTP expired",
	// "Invalid OTP", "Too many attempts", from email-otp/error-codes.mjs) — fine for a log line, not
	// for a person reading it. Map the ones we know; fall back to the raw message for anything else
	// rather than inventing a blanket "something went wrong" that hides real detail.
	const RATE_LIMITED = "rate-limited";
	const DEAD_CODE_ERRORS = new Set(["OTP expired", "Too many attempts", RATE_LIMITED]);
	// The rate limiter answers a burst of tries with a 429 before email-otp sees the code,
	// and that code is spent by the time the limit lifts, so it is a dead code too. (CUR-3048)
	function otpErrorKey(error: { status?: number; message?: string }): string | undefined {
		return error.status === 429 ? RATE_LIMITED : error.message;
	}
	function friendlyOtpError(message: string | undefined): string {
		switch (message) {
			case RATE_LIMITED:
				return "Too many tries in a row, so that code no longer works. Wait a minute, then send a new code below.";
			case "OTP expired":
				return "That code has expired. Send a new code below.";
			case "Invalid OTP":
				return "That code doesn't match. Check it and try again.";
			case "Too many attempts":
				return "Too many tries, so that code no longer works. Send a new code below.";
			default:
				return message ?? "That code didn't match.";
		}
	}

	// The <input type="email" required> below would rely entirely on the browser's own constraint
	// validation (native tooltip on submit) for feedback, which an automation harness reading the DOM
	// cannot see and which is inconsistent with the errorMsg convention this same page uses for every
	// other failure below. `novalidate` on the form turns the native check off so this runs instead
	// (CUR-1064).
	const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	function sendOtp() {
		return withBusy("send-otp", async () => {
			const trimmed = email.trim();
			if (!trimmed) {
				errorMsg = "Enter your email address.";
				return;
			}
			if (!EMAIL_PATTERN.test(trimmed)) {
				errorMsg = "That doesn't look like a valid email address.";
				return;
			}
			// Keep the bound value in sync so the OTP-code phase's "sent to {email}" and verifyOtp()'s
			// own request both use the same trimmed address, not a whitespace-padded original.
			email = trimmed;
			const { error } = await authClient.emailOtp.sendVerificationOtp({ email: trimmed, type: "sign-in" });
			if (error) {
				errorMsg = error.message ?? "Couldn't send a code to that address.";
				return;
			}
			resent = false;
			phase = "otp-code";
		});
	}

	// An expired code and a code locked after three wrong tries both tell the person to send a new
	// one, so the code screen needs a control that does it without going back to the email step and
	// retyping the address. This resends to the same address and clears the dead code (CUR-2793).
	let resent = $state(false);
	function resendOtp() {
		return withBusy("resend-otp", async () => {
			const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
			if (error) {
				errorMsg = error.message ?? "Couldn't send a new code.";
				return;
			}
			otp = "";
			lastAutoSubmitted = "";
			verifiedCode = "";
			resent = true;
		});
	}

	// withBusy's `finally` resets `busy` to null even after a SUCCESSFUL verify, and `otp`
	// is never cleared on success (the page is expected to navigate away via afterSignIn's
	// window.location.href, which doesn't halt script execution immediately). In that window, a second
	// trigger — most often a reflexive extra Enter press on the form, since the auto-submit effect's
	// own lastAutoSubmitted guard already covers itself — can resubmit the SAME, now-already-consumed
	// code and get a real rejection from the backend: a genuine successful sign-in followed by a false
	// "code didn't match" error. Guarded here, shared by both entry points, rather than only inside the
	// effect. Deliberately does NOT block resubmitting a code that genuinely FAILED — verifiedCode is
	// only ever set on success, so a manual retry after a real rejection is untouched (CUR-1131).
	//
	// The same window has a visible half: `busy` clearing re-enables the Verify button and its label
	// reverts to "Verify" while the code is still visibly accepted and correct, up to ~2.3s before
	// the redirect lands, and nothing on screen tells the person their code was accepted. The button
	// below stays disabled and relabelled for as long as verifiedCode is set, covering this window as
	// well as the busy === "verify-otp" one (CUR-1481).
	let verifiedCode = $state("");

	function verifyOtp() {
		if (otp === verifiedCode) return;
		return withBusy("verify-otp", async () => {
			const { error } = await authClient.signIn.emailOtp({ email, otp });
			if (error) {
				const key = otpErrorKey(error);
				errorMsg = friendlyOtpError(key);
				// An expired or locked code can never work again, so clearing it also disables
				// Verify and leaves Send a new code as the one way on. A mistyped code stays for correcting. (CUR-2879)
				if (DEAD_CODE_ERRORS.has(key ?? "")) otp = "";
				return;
			}
			verifiedCode = otp;
			afterSignIn();
		});
	}

	// Auto-submit once a full code is typed or pasted — one less click, standard OTP-input practice.
	// Guarded on lastAutoSubmitted (not just busy) so a rejected code doesn't loop: verifyOtp() clears
	// busy when it fails, but otp itself is left untouched at length 6, and a bare `otp.length === 6`
	// effect would immediately refire on that same value forever.
	let lastAutoSubmitted = $state("");
	$effect(() => {
		if (otp.length === 6 && otp !== lastAutoSubmitted && !busy) {
			lastAutoSubmitted = otp;
			verifyOtp();
		}
	});

</script>

<svelte:head>
	<title>Sign in — Alpha</title>
	<meta name="description" content="Sign in to {APP_NAME} — a public, open source AI, free to use during the open alpha." />
</svelte:head>

{#snippet icon(path: string, cls = "size-4")}
	<svg viewBox="0 0 24 24" fill="currentColor" class={cls} aria-hidden="true"><path d={path} /></svg>
{/snippet}

<!-- Sign in as a branded modal over a soft backdrop (an edge-to-edge sheet on phones): the brand band sets
     the tone, then one clear path — email first, other providers as equals, passkey last. -->
<div class="signin-stage relative flex min-h-full w-full items-start justify-center p-4 max-sm:items-stretch max-sm:p-0" data-signin>
	<div
		class="relative flex w-full max-w-md flex-col overflow-hidden border border-line-2 bg-surface-raised shadow-window rounded-field signin-card max-sm:max-w-none max-sm:border-0 max-sm:shadow-none"
		role="dialog"
		aria-modal="false"
		aria-labelledby="signin-title"
	>
		<div class="absolute top-2 right-2 z-raised">
			<Button href={data.next ?? `${base}/`} variant="ghost" size="icon" shape="pill" aria-label="Close sign in">
				<RiCloseLine aria-hidden="true" />
			</Button>
		</div>

		<SignInHero compact={phase === "otp-code"} />

		<div class="flex flex-col gap-5 px-6 pt-2 pb-6">
			<header class="flex flex-col gap-1.5 text-center">
				<h1 id="signin-title" class="type-heading text-fg-1">
					{phase === "otp-code" ? "Check your email" : "Sign in to Alpha"}
				</h1>
				{#if phase === "otp-code"}
					<p class="type-caption text-fg-2">
						{#if resent}
							We sent a new code to <span class="text-fg-1">{email}</span>.
						{:else}
							We sent a 6-digit code to <span class="text-fg-1">{email}</span>.
						{/if}
					</p>
				{/if}
			</header>

			{#if errorMsg}
				<p role="alert" class="flex items-start gap-2 border border-line-2 bg-surface-2 px-3 py-2 type-caption text-fg-1 rounded-card">
					{@render icon(ICONS.errorWarning, "mt-px size-4 shrink-0 text-accent-2")}
					<span>{errorMsg}</span>
				</p>
			{/if}

			{#if phase === "chooser"}
				<form
					class="flex flex-col gap-2"
					novalidate
					onsubmit={(e) => {
						e.preventDefault();
						sendOtp();
					}}
				>
					<label for="signin-email" class="sr-only">Email</label>
					<Input
						id="signin-email"
						type="email"
						required
						autocomplete="email webauthn"
						bind:value={email}
						disabled={!!busy}
						size="lg"
						placeholder="you@example.org"
					/>
					<Button type="submit" variant="primary" size="lg" casing="sentence" block disabled={!!busy || !hydrated}>
						{@render icon(ICONS.mail)}
						{busy === "send-otp" ? "Sending…" : "Continue with email"}
					</Button>
				</form>

				<!-- CUR-2468: every route after email is one bordered button in one group, passkey included,
				     so five ways in read as five equal choices. Passkey stays last (CUR-608): it only signs in
				     against a credential that already exists. -->
				<div class="flex items-center gap-3" aria-hidden="true">
					<span class="h-px flex-1 bg-line-1"></span>
					<span class="type-caption text-fg-3">or</span>
					<span class="h-px flex-1 bg-line-1"></span>
				</div>
				<div class="grid gap-2 {alternateColumns}">
					{#if data.providers.google}
						<Button variant="secondary" size="lg" casing="sentence" block disabled={!!busy || !!leavingFor} onclick={() => signInSocial("google")} aria-label="Continue with Google">
							{@render icon(ICONS.google)}
							{busy === "google" || leavingFor === "google" ? "Redirecting…" : "Google"}
						</Button>
					{/if}
					{#if data.providers.github}
						<Button variant="secondary" size="lg" casing="sentence" block disabled={!!busy || !!leavingFor} onclick={() => signInSocial("github")} aria-label="Continue with GitHub">
							{@render icon(ICONS.github)}
							{busy === "github" || leavingFor === "github" ? "Redirecting…" : "GitHub"}
						</Button>
					{/if}
					{#if data.providers.huggingface}
						<Button variant="secondary" size="lg" casing="sentence" block disabled={!!busy || !!leavingFor} onclick={() => signInSocial("huggingface")} aria-label="Continue with Hugging Face">
							{@render icon(ICONS.robot)}
							{busy === "huggingface" || leavingFor === "huggingface" ? "Redirecting…" : "Hugging Face"}
						</Button>
					{/if}
					<Button
						variant="secondary"
						size="lg"
						casing="sentence"
						block
						disabled={!!busy && busy !== "passkey"}
						onclick={busy === "passkey" ? cancelPasskey : signInPasskey}
						aria-label={busy === "passkey" ? "Waiting for your device — Cancel" : "Use a passkey you’ve added"}
						title="Signs in with a passkey you’ve already added to your account"
					>
						{@render icon(ICONS.fingerprint)}
						{busy === "passkey" ? "Cancel" : "Passkey"}
					</Button>
				</div>

				<!-- CUR-1133: disableImplicitLinking (betterAuth.ts) refuses a second provider on an address that
				     already has an account (account_not_linked), so a provider is added by linking it in Settings
				     while signed in. CUR-3157: an email code finds the account by address, and the line says both. -->
				<p class="text-center type-caption text-fg-3">
					An email code opens the account that uses that address. To add Google, GitHub or Hugging Face as
					another way in, sign in first, then link it in Settings.
				</p>
			{:else if phase === "otp-code"}
				<form
					class="flex flex-col gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						verifyOtp();
					}}
				>
					<label class="sr-only" for="signin-otp">6-digit code</label>
					<!-- CUR-2298: the field mounts each time this phase opens, including after "Use a different
					     email" sends a new code, so focusing on attach puts the cursor in it every time. -->
					<Input
						id="signin-otp"
						type="text"
						inputmode="numeric"
						autocomplete="one-time-code"
						required
						bind:value={otp}
						size="lg"
						appearance="code"
						placeholder="000000"
						{@attach (node) => node.focus()}
					/>
					<Button type="submit" variant="primary" size="lg" casing="sentence" block disabled={!!busy || !hydrated || otp.length < 6 || !!verifiedCode}>
						{busy === "verify-otp" || verifiedCode ? "Signing you in…" : "Verify and sign in"}
						<!-- CUR-1621: the label alone sat still for the whole wait, which reads as a stalled page.
						     Hidden from the accessibility tree so the button's name stays the label. -->
						{#if busy === "verify-otp" || verifiedCode}
							<!-- CUR-2660: `flex` makes the Spinner a flex item. In a block wrapper it is an inline-grid
							     with no text, so it sat on the label's baseline, 5.75px below the label's centre. -->
							<span aria-hidden="true" data-signing-in-spinner class="flex"><Spinner size="sm" /></span>
						{:else}
							{@render icon(ICONS.arrowRight, "size-4")}
						{/if}
					</Button>
					<Button
						variant="ghost"
						size="md"
						casing="sentence"
						block
						disabled={!!busy || !hydrated || !!verifiedCode}
						onclick={resendOtp}
					>
						{busy === "resend-otp" ? "Sending…" : "Send a new code"}
					</Button>
					<Button
						variant="ghost"
						size="md"
						casing="sentence"
						block
						onclick={() => {
							// Reset `phase` and the error: an invalid-OTP banner ("That code doesn't match…") would
							// otherwise stay on screen under the email step it no longer describes. sendOtp()'s own errorMsg
							// reset (inside withBusy) only fires on the NEXT submit, and this button routes back to email
							// entry without one (CUR-1418).
							phase = "chooser";
							errorMsg = "";
							// Clear the rejected code, or the next address's code screen opens already filled with it.
							// Clearing lastAutoSubmitted too lets a code the person really does receive twice still
							// auto-submit (CUR-1887).
							otp = "";
							lastAutoSubmitted = "";
							resent = false;
						}}
					>
						Use a different email
					</Button>
				</form>
			{/if}
		</div>
	</div>
</div>

<style>
	/* A soft brand backdrop behind the sign-in card. */
	.signin-stage {
		background:
			radial-gradient(ellipse 60% 50% at 20% 0%, color-mix(in oklch, var(--ds-accent-1) 20%, transparent), transparent 70%),
			radial-gradient(ellipse 50% 50% at 90% 100%, color-mix(in oklch, var(--ds-xray-glow) 16%, transparent), transparent 70%),
			var(--ds-bg-1);
	}
	/* The card hangs from a fixed distance below the top instead of being centred, so an error (CUR-3491)
	   box or the code step growing it pushes its bottom edge down and never lifts the part being read. */
	@media (min-width: 640px) {
		.signin-stage {
			padding-top: max(1rem, 12dvh);
		}
	}
	/* Phones: an edge-to-edge sheet filling the screen — no radius, no frame. */
	@media (max-width: 639px) {
		.signin-card {
			border-radius: 0;
		}
	}
</style>
