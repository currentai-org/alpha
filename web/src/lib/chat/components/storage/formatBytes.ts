// CUR-1276. Bytes come back raw from listCustodialFiles (StorageFile.size) — this is the one place
// that turns them into the "1.2 MB" a person reads. Base-1000 (MB, not MiB): CUSTODIAL_MAX_BYTES_PER_FILE
// and CUSTODIAL_MAX_TOTAL_BYTES_PER_USER in custodialUpload.ts are themselves decimal (4_400_000,
// 250_000_000), so a binary-prefix formatter here would make the displayed cap disagree with the
// enforced one.
export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1000;
	let unitIndex = 0;
	while (value >= 1000 && unitIndex < units.length - 1) {
		value /= 1000;
		unitIndex++;
	}
	const digits = value < 10 ? 1 : 0;
	return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
