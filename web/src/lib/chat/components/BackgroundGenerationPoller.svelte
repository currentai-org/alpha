<script lang="ts">
	import { onDestroy } from "svelte";
	import { browser, dev } from "$app/environment";
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import { safeInvalidate } from "$lib/chat/utils/safeInvalidate";

	import {
		backgroundGenerationEntries,
		removeBackgroundGeneration,
		MAX_TRACK_DURATION_MS,
	} from "$lib/chat/stores/backgroundGenerations";
	import { UrlDependency } from "$lib/chat/types/UrlDependency";
	import { useConversationsStore } from "$lib/chat/stores/conversations.svelte";

	/**
	 * How long to wait before reconnecting the SSE stream after it closes
	 * (the server closes it gracefully at its MAX_LIFETIME_MS; use a brief delay
	 * so we do not hammer the server if there is a transient error).
	 */
	const RECONNECT_DELAY_MS = 1_000;

	const convsStore = useConversationsStore();

	// $effect.root creates a PRESERVED root, deliberately exempt from the normal parent-effect
	// destroy cascade (Svelte's own effect_root() docs this as `EFFECT_PRESERVED`) — the dispose
	// function it returns must be invoked explicitly, or the effect (and the SSE connection + evict
	// interval it owns) outlives this component's unmount. This component is mounted once, for the
	// whole session, at ChatShell — so in normal use nothing ever unmounts it and the leak has no
	// observable effect. It surfaces the moment anything mounts this component more than once in the
	// same page (a component test, or any future conditional/per-conversation remount): the OLD
	// instance's root effect keeps running and reacts to the shared backgroundGenerationEntries store
	// right alongside the new one, opening a second EventSource nobody asked for. In a test this shows as
	// two "opening SSE stream" logs for one addBackgroundGeneration() call, even with cleanup()
	// between cases (CUR-1157).
	const disposeRoot = $effect.root(() => {
		if (!browser) return;

		let destroyed = false;
		let eventSource: EventSource | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

		const log = (...args: unknown[]) => {
			if (dev) console.log("[BackgroundGenerationPoller]", ...args);
		};

		/** Most-recent updatedAt seen across all events; used as reconnect cursor. */
		let latestCursor = new Date(0).toISOString();

		function openStream() {
			if (destroyed || backgroundGenerationEntries.length === 0) return;
			if (eventSource) return; // already open

			const url = new URL(`${base}/api/v2/conversations/updates`, window.location.href);
			url.searchParams.set("cursor", latestCursor);

			log("opening SSE stream, cursor:", latestCursor);
			eventSource = new EventSource(url.toString());

			eventSource.addEventListener("update", (raw) => {
				if (destroyed) return;

				let event: {
					id: string;
					title: string;
					updatedAt: string;
					isTerminal: boolean;
				};
				try {
					event = JSON.parse(raw.data) as typeof event;
				} catch (err) {
					console.error("[BackgroundGenerationPoller] bad SSE payload", err);
					return;
				}

				log("update", event);

				// Advance cursor
				if (event.updatedAt > latestCursor) {
					latestCursor = event.updatedAt;
				}

				// Update sidebar title / updatedAt for this conversation
				convsStore.update(event.id, {
					title: event.title,
					updatedAt: new Date(event.updatedAt),
				});

				const isTracked = backgroundGenerationEntries.some((e) => e.id === event.id);
				if (!isTracked) return;

				if (event.isTerminal) {
					removeBackgroundGeneration(event.id);
					log("complete", event.id);

					// Refresh the sidebar via the client-owned store, then invalidate the
					// conversation detail if the user is currently viewing it.
					void convsStore.refresh().then(() => {
						// Only invalidate the conversation detail when it is currently open
						if (page.params.id === event.id) {
							return safeInvalidate(UrlDependency.Conversation);
						}
					});
				} else {
					// Non-terminal update: if the affected conversation is open, refresh it
					if (page.params.id === event.id) {
						void safeInvalidate(UrlDependency.Conversation);
					}
				}
			});

			eventSource.onerror = () => {
				if (destroyed) return;
				log("SSE error / close — scheduling reconnect");
				closeStream();
				// Reconnect only if there are still entries to track
				if (backgroundGenerationEntries.length > 0) {
					reconnectTimer = setTimeout(() => {
						reconnectTimer = null;
						openStream();
					}, RECONNECT_DELAY_MS);
				}
			};
		}

		function closeStream() {
			if (eventSource) {
				eventSource.close();
				eventSource = null;
				log("SSE stream closed");
			}
		}

		// Timeout guard: entries that have been tracked too long are evicted,
		// mirroring the old poller's MAX_POLL_DURATION_MS behaviour.
		function evictTimedOutEntries() {
			const now = Date.now();
			const timedOut = backgroundGenerationEntries.filter(
				(e) => now - e.startedAt > MAX_TRACK_DURATION_MS
			);
			for (const entry of timedOut) {
				removeBackgroundGeneration(entry.id);
				log("timeout evict", entry.id);
				void convsStore.refresh().then(() => {
					if (page.params.id === entry.id) {
						return safeInvalidate(UrlDependency.Conversation);
					}
				});
			}
		}

		// Evict timed-out entries on an interval even when the SSE stream is quiet.
		const evictTimer = setInterval(evictTimedOutEntries, 10_000);

		$effect(() => {
			// Reactive dep: re-evaluate whenever the entries array changes.
			const hasEntries = backgroundGenerationEntries.length > 0;

			if (destroyed) return;

			if (hasEntries) {
				openStream();
			} else {
				// No active generations — close the stream to conserve connections.
				if (reconnectTimer !== null) {
					clearTimeout(reconnectTimer);
					reconnectTimer = null;
				}
				closeStream();
			}
		});

		return () => {
			destroyed = true;
			clearInterval(evictTimer);
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			closeStream();
		};
	});

	onDestroy(disposeRoot);
</script>
