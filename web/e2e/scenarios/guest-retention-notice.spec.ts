// e2e-product: @chat
// e2e-area: @auth
import { test, expect } from './helpers/test';
import { chatEntry } from './helpers/chatEntry';
import { journeyStep } from './helpers/journeyStep';
import { signInAsFreshUser } from './helpers/session';
import { installCannedReplies } from './helpers/faultInjection';
import { startChattingPastWelcome } from './helpers/welcome';
import { scrollFooterToRest } from './helpers/footer';

// A3 ("My data stays mine, and I can take it with me") has no filmed journey at all.
// Its claim (CUR-643): anonymous visitors see a warning that their conversation is deleted after 30 days
// idle, instead of losing it with no notice.
// The harder A3 surfaces — data export, custodial storage view — are auth-gated and
// read false in production right now, so they need `setFlagOverrides` and an `@preview-only` tag;
// this one needs neither. It fires for any anonymous visitor with a conversation, on any
// deployment, which is why it is the first A3 spec rather than one of those.
//
// GuestRetentionNotice.svelte is a quiet inline note (CUR-1429), not a
// full-width amber banner with a "sign in to keep it" link:
// that banner oversold sign-in as the remedy and overstated a normal privacy default as a
// fault. This spec asserts the note exists and names the retention window — not the banner
// treatment, and not the exact prose, which is editable catalog copy
// (`copy_guestRetentionNotice` in web/messages) rather than a stable contract. The one word this
// spec pins is "30", because that comes from the RETENTION_DAYS code constant
// (constants/retention.ts) the message interpolates, not from editable text.
//
// No `setFlagOverrides` and no `@preview-only`: `showGuestRetentionNotice` in ChatWindow.svelte
// gates on `!page.data.user && !shared && (messages.length > 0 || pending)` — session state, not a
// PostHog flag. Signed-out is the only precondition, and every environment can produce it.
test(
	'an anonymous visitor sees a 30-day retention notice once a conversation exists',
	{ tag: '@A3' },
	async ({ page }) => {
		// Same overlay hazard as the other scenarios in this suite: the welcome dialog's mount is
		// gated on an async settings load and can interrupt at any point after first paint.
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});

		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);

		// Before anything is sent, ChatIntroduction owns the retention disclosure (`landing.privacy_note`)
		// on the empty state — that line disappears the moment a guest sends
		// their first message. Asserting its absence here would pin ChatIntroduction's behavior, which
		// isn't this ticket's claim; the claim under test starts once a conversation exists.
		const composer = page.getByLabel('Message AI Potluck');
		await journeyStep(page, 'A3', 2, async () => {
			await composer.click({ timeout: 30_000 });
			await composer.fill('What should I pack for a weekend in the Alps?');
			await composer.press('Enter');

			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			await expect(welcomeDialog).toBeHidden({ timeout: 15_000 });

			// This is the gap the notice closes: with the conversation now non-empty, ChatIntroduction's
			// own notice is gone, and GuestRetentionNotice is the only thing that can still tell an
			// anonymous visitor their data is on a clock.
			await expect(page.getByText(/30 days/i)).toBeVisible({ timeout: 15_000 });
		});
	}
);

// The sibling test above proves the guest line renders; this proves the SAME clock does
// not follow a signed-in account onto the empty state it lands on first. Without this, a notice
// shown to everybody satisfies the guest test exactly as well as one gated correctly — the guest
// test alone cannot tell the two apart, so the gate needs its own test (CUR-1731).
test(
	'a signed-in account does not see the guest 30-day retention line on the empty state',
	{ tag: '@A3' },
	async ({ page }) => {
		await signInAsFreshUser(page);

		// A fresh account has no conversation history, so a redirect from sign-in already lands here —
		// navigating explicitly rather than trusting that removes any dependency on where it happens to
		// leave the session.
		await page.goto(chatEntry(), { waitUntil: 'load' });

		// cleanup.ts's own sweep only ever matches conversations with a NULL userId, so a signed-in
		// account's conversations carry no expiry clock at all — landing.privacy_note_signed_in
		// (registry.ts) is the copy for this audience, and it names no day count.
		await expect(page.getByText(/30 days/i)).not.toBeVisible({ timeout: 15_000 });
	}
);

// A3 step 8: before deciding to stay, a guest reads the privacy notice and the trust page. The walk
// starts in Data & privacy and follows the product's own links, so a page nothing links to fails here.
// The notice is CMS copy; this pins only the two sentences that say what deletion reaches, the
// Account Settings route and the anonymous-history attach that deleting the account cannot undo.
// Two known contradictions in the notice are filed, not asserted: "we do not store your messages"
// beside 30-day guest retention (CUR-2064), and the gateway's unbounded log of prompts (CUR-2185).
test(
	'a guest reaches the privacy notice from Data & privacy, reads what deletion reaches, and finds the trust page',
	{ tag: '@A3' },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await journeyStep(page, 'A3', 8, async () => {
			await page.goto('/chat/settings/data', { waitUntil: 'load' });
			await page.getByRole('link', { name: 'Read the full privacy notice' }).click();
			await page.waitForURL(/\/privacy-notice$/, { timeout: 30_000 });

			const notice = page.locator('main');
			await expect(notice.getByRole('heading', { level: 1 })).toContainText('Privacy Notice', {
				timeout: 15_000
			});
			await expect(
				notice.getByText(/delete your account and its data from Account Settings/i),
				'the notice no longer says where a person deletes their account'
			).toBeVisible();
			await expect(
				notice.getByText(/cannot be undone by signing out or deleting your account/i),
				'the notice no longer says what deleting the account does not undo'
			).toBeVisible();

			// A reader scrolls to the footer and clicks once it stops moving; Playwright's own scroll
			// lands the lagged footer under the fixed header (CUR-4492).
			const trustLink = page.locator('footer').getByRole('link', { name: 'Trust and Safety' });
			await scrollFooterToRest(page, trustLink);
			await trustLink.click();
			await page.waitForURL(/\/trust-and-safety$/, { timeout: 30_000 });
			await expect(page.locator('main').getByRole('heading', { level: 1 })).toContainText(
				'Trust & Safety',
				{ timeout: 15_000 }
			);
			await expect(
				page.locator('main').getByText(/how to request deletion/i),
				'the trust page no longer points to where deletion is explained'
			).toBeVisible();
		});
	}
);

// A3 step 1: before a guest has sent anything, the empty-state note carries the retention rule and the
// in-conversation notice stays away. The same test then sends a message and sees `[data-guest-retention]`
// appear, so the absence is checked with a selector proven to find the notice once it exists.
test(
	'before a first message, only the empty-state note names the retention rule, and the guest notice waits for a conversation',
	{ tag: '@A3' },
	async ({ page }) => {
		const welcomeDialog = page.getByRole('dialog', { name: 'Welcome to Alpha' });
		await page.addLocatorHandler(welcomeDialog, async () => {
			await startChattingPastWelcome(welcomeDialog);
		});
		await page.goto(chatEntry(), { waitUntil: 'commit' });
		await installCannedReplies(page);

		const composer = page.getByLabel('Message AI Potluck');
		const guestNotice = page.locator('[data-guest-retention]');
		await journeyStep(page, 'A3', 1, async () => {
			await composer.click({ timeout: 30_000 });
			await expect(
				page.getByText(/30 days/i).first(),
				'the empty state no longer names the retention rule'
			).toBeVisible({ timeout: 15_000 });
			await expect(
				guestNotice,
				'the in-conversation retention notice shows before there is a conversation to warn about'
			).toHaveCount(0);

			await composer.fill('What should I pack for a weekend in the Alps?');
			await composer.press('Enter');
			await page.waitForURL(/\/chat\/conversation\/[a-f0-9]+/, { timeout: 30_000 });
			await expect(guestNotice.first()).toBeVisible({ timeout: 15_000 });
		});
	}
);
