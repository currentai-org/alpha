<script lang="ts">
	import RiFileForbidLine from '~icons/ri/file-forbid-line';
	import { fileTypeLabel } from '$lib/chat/utils/fileTypeLabel';

	// A file the server left out of a sent message (scanner down, a type or document not
	// accepted, a file it could not check). It stays in the message, marked not added, so it doesn't
	// vanish when the answer lands; the answer's note says why. Only its name was kept, so there is
	// nothing to open. (CUR-3405)
	interface Props {
		name: string;
		mime: string;
	}
	let { name, mime }: Props = $props();
</script>

<div
	class="flex h-14 w-64 items-center gap-2 overflow-hidden border border-dashed border-line-2 p-2 text-fg-2 rounded-card"
	data-left-out-file
>
	<div class="grid size-10 flex-none place-items-center bg-surface-2 rounded-sharp">
		<RiFileForbidLine class="text-body" aria-hidden="true" />
	</div>
	<dl class="flex flex-col items-start truncate leading-tight">
		<dd class="truncate text-small line-through">{name}</dd>
		<dt class="text-micro text-fg-3">Not added · {fileTypeLabel(mime, name)}</dt>
	</dl>
</div>
