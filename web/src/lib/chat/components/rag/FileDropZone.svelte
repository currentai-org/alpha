<!-- RAG admin multi-file upload: drag-drop zone + accessible hidden input, staged file list with
     per-file state (waiting / uploading / done / error), XHR upload (fetch can't report upload
     progress) with a small concurrency cap, per-file remove + retry. Each file is POSTed individually
     to /tuning/rag/upload which lands it as an INACTIVE draft; on completion we invalidateAll() so the
     Documents list below refreshes. Selection NEVER auto-uploads — the admin reviews the staged list,
     sets an optional shared source/date, then clicks Upload. -->
<script lang="ts">
	import { base } from "$lib/chat/paths";
	import { invalidateAll } from "$app/navigation";
	import {
		UPLOAD_ACCEPT,
		SUPPORTED_FORMATS_LABEL,
		MAX_UPLOAD_FILES,
		UPLOAD_MAX_BYTES,
		classifyUpload,
		type UploadKind,
	} from "$lib/chat/constants/ragUpload";
	import CarbonClose from "~icons/carbon/close";
	import CarbonUpload from "~icons/carbon/cloud-upload";
	import CarbonRenew from "~icons/carbon/renew";

	type Status = "waiting" | "uploading" | "done" | "error";
	interface Item {
		id: string;
		file: File;
		name: string;
		size: number;
		kind: UploadKind | null;
		status: Status;
		progress: number;
		message: string;
		xhr?: XMLHttpRequest;
	}

	let items = $state<Item[]>([]);
	let dragging = $state(false);
	let uploading = $state(false);
	let source = $state("");
	let sourceDate = $state("");
	let inputEl = $state<HTMLInputElement>();

	let seq = 0;
	const uid = () => `f${(seq++).toString(36)}-${items.length}`;

	const pending = $derived(items.filter((i) => i.status === "waiting").length);
	const doneCount = $derived(items.filter((i) => i.status === "done").length);
	const errorCount = $derived(items.filter((i) => i.status === "error").length);

	function fmtSize(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	/** True only for items that failed an actual upload attempt (a valid, in-cap file) — not for
	 *  client-rejected unsupported/oversize files, where retry can't help. */
	function retryable(item: Item): boolean {
		return (
			item.status === "error" && item.kind !== null && item.size <= UPLOAD_MAX_BYTES[item.kind]
		);
	}

	function addFiles(files: FileList | File[]) {
		for (const file of Array.from(files)) {
			if (items.length >= MAX_UPLOAD_FILES) {
				break;
			}
			const kind = classifyUpload(file.name, file.type);
			const overCap = kind ? file.size > UPLOAD_MAX_BYTES[kind] : false;
			items.push({
				id: uid(),
				file,
				name: file.name,
				size: file.size,
				kind,
				status: !kind || overCap ? "error" : "waiting",
				progress: 0,
				message: !kind
					? "Unsupported file type"
					: overCap
						? `Too large (max ${fmtSize(UPLOAD_MAX_BYTES[kind])})`
						: "",
			});
		}
	}

	function onPick(e: Event) {
		const t = e.currentTarget as HTMLInputElement;
		if (t.files) addFiles(t.files);
		t.value = ""; // allow re-selecting the same file
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
	}

	function removeItem(id: string) {
		const it = items.find((i) => i.id === id);
		it?.xhr?.abort();
		items = items.filter((i) => i.id !== id);
	}

	function clearFinished() {
		for (const it of items) if (it.status === "uploading") it.xhr?.abort();
		items = items.filter((i) => i.status === "waiting");
	}

	function uploadOne(item: Item): Promise<void> {
		return new Promise((resolve) => {
			const fd = new FormData();
			fd.append("files", item.file, item.name);
			if (source.trim()) fd.append("source", source.trim());
			if (sourceDate) fd.append("sourceDate", sourceDate);

			const xhr = new XMLHttpRequest();
			item.xhr = xhr;
			item.status = "uploading";
			item.progress = 0;
			item.message = "";

			xhr.open("POST", `${base}/admin/rag/upload`);
			xhr.upload.onprogress = (ev) => {
				if (ev.lengthComputable) item.progress = Math.round((ev.loaded / ev.total) * 100);
			};
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					item.status = "done";
					item.progress = 100;
					let warn = "";
					try {
						const d = JSON.parse(xhr.responseText);
						if (d.duplicateChunkCount > 0) {
							warn = `draft created · ${d.duplicateChunkCount} duplicate chunk(s)`;
						} else {
							warn = "draft created";
						}
					} catch {
						warn = "draft created";
					}
					item.message = warn;
				} else {
					item.status = "error";
					item.message = (xhr.responseText || `Error ${xhr.status}`).slice(0, 240);
				}
				resolve();
			};
			xhr.onerror = () => {
				item.status = "error";
				item.message = "Network error — check your connection and retry.";
				resolve();
			};
			xhr.onabort = () => resolve();
			xhr.send(fd);
		});
	}

	async function uploadAll() {
		const queue = items.filter((i) => i.status === "waiting");
		if (queue.length === 0) return;
		uploading = true;
		const CONCURRENCY = 3;
		let next = 0;
		const worker = async () => {
			while (next < queue.length) {
				await uploadOne(queue[next++]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
		uploading = false;
		await invalidateAll(); // refresh the Documents list to show the new drafts
	}

	async function retryItem(item: Item) {
		await uploadOne(item);
		await invalidateAll();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			inputEl?.click();
		}
	}
</script>

<div class="flex flex-col gap-3">
	<!-- Drop zone: visible Browse + accessible (sr-only, NOT display:none) native multiple input. -->
	<div
		role="button"
		tabindex="0"
		aria-label="Upload files — drop here or browse"
		class="flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-center transition-colors {dragging
			? 'border-[var(--ap-ink)] bg-[var(--ap-ink)]/5'
			: 'border-[var(--ap-rule)]'}"
		onclick={() => inputEl?.click()}
		onkeydown={onKeydown}
		ondragover={(e) => {
			e.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
	>
		<CarbonUpload class="text-2xl text-[var(--ap-ink-3)]" />
		<p class="text-[length:var(--ap-text-3)]">
			<span class="font-medium text-[var(--ap-ink)]">Browse</span> or drop files here
		</p>
		<p class="text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]">
			{SUPPORTED_FORMATS_LABEL} · up to {MAX_UPLOAD_FILES} files
		</p>
		<input
			bind:this={inputEl}
			type="file"
			multiple
			accept={UPLOAD_ACCEPT}
			onchange={onPick}
			class="sr-only"
		/>
	</div>

	<!-- Shared provenance for the whole batch (each defaults to the filename / today if left blank). -->
	{#if items.length > 0}
		<div class="grid grid-cols-2 gap-3">
			<label class="text-[length:var(--ap-text-2)]">
				Source (optional — defaults to filename)
				<input
					bind:value={source}
					placeholder="e.g. Internal report"
					class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
				/>
			</label>
			<label class="text-[length:var(--ap-text-2)]">
				Source date (optional — defaults to today)
				<input
					type="date"
					bind:value={sourceDate}
					class="mt-1 w-full rounded border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2 py-1"
				/>
			</label>
		</div>

		<ul class="flex flex-col gap-1.5">
			{#each items as item (item.id)}
				<li class="rounded border border-[var(--ap-rule)] px-3 py-2 text-[length:var(--ap-text-3)]">
					<div class="flex items-center gap-2">
						<span class="min-w-0 flex-1 truncate">
							<span class="font-medium">{item.name}</span>
							<span class="text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]"
								>· {fmtSize(item.size)}{item.kind ? ` · ${item.kind}` : ""}</span
							>
						</span>
						{#if item.status === "done"}
							<span class="shrink-0 text-[length:var(--ap-text-2)]" style="color:var(--ap-live)">✓</span>
						{:else if item.status === "error"}
							<span class="shrink-0 text-[length:var(--ap-text-2)]" style="color:var(--ap-gap)">✗</span>
						{:else if item.status === "uploading"}
							<span class="shrink-0 font-mono text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]">{item.progress}%</span
							>
						{/if}
						{#if retryable(item)}
							<button
								type="button"
								class="shrink-0 rounded border border-[var(--ap-rule)] p-1 text-[var(--ap-ink-2)] hover:bg-[var(--ap-rule)]/20"
								aria-label="Retry {item.name}"
								onclick={() => retryItem(item)}
							>
								<CarbonRenew class="text-xs" />
							</button>
						{/if}
						{#if item.status !== "uploading"}
							<button
								type="button"
								class="shrink-0 rounded border border-[var(--ap-rule)] p-1 text-[var(--ap-ink-2)] hover:bg-[var(--ap-rule)]/20"
								aria-label="Remove {item.name}"
								onclick={() => removeItem(item.id)}
							>
								<CarbonClose class="text-xs" />
							</button>
						{/if}
					</div>
					{#if item.status === "uploading"}
						<div
							class="mt-1.5 h-1 w-full overflow-hidden rounded bg-[var(--ap-rule)]/40"
							role="progressbar"
							aria-valuenow={item.progress}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-label="Uploading {item.name}"
						>
							<div
								class="h-full rounded bg-[var(--ap-ink)] transition-all"
								style="width:{item.progress}%"
							></div>
						</div>
					{/if}
					{#if item.message}
						<p
							class="mt-1 text-[length:var(--ap-text-2)]"
							style="color:{item.status === 'error' ? 'var(--ap-gap)' : 'var(--ap-ink-3)'}"
						>
							{item.message}
						</p>
					{/if}
				</li>
			{/each}
		</ul>

		<div class="flex items-center justify-between gap-3">
			<p class="text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]" aria-live="polite">
				{items.length} staged · {doneCount} uploaded{errorCount ? ` · ${errorCount} failed` : ""}
			</p>
			<div class="flex gap-2">
				<button
					type="button"
					class="rounded border border-[var(--ap-rule)] px-3 py-1 text-[length:var(--ap-text-2)] text-[var(--ap-ink-2)] disabled:opacity-50"
					onclick={clearFinished}
					disabled={uploading || items.length === 0}>Clear</button
				>
				<button
					type="button"
					class="rounded bg-[var(--ap-ink)] px-4 py-1 text-[length:var(--ap-text-2)] text-[var(--ap-paper)] disabled:opacity-50"
					onclick={uploadAll}
					disabled={uploading || pending === 0}
				>
					{uploading ? "Uploading…" : `Upload ${pending} file${pending === 1 ? "" : "s"}`}
				</button>
			</div>
		</div>
		<p class="text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]">
			Each file becomes an inactive <strong>draft</strong> — preview and activate it below to serve it.
		</p>
	{/if}
</div>
