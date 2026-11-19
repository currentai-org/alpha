/**
 * Browser-only: save `blob` as `filename` through a temporary link, without leaving the page. No-op
 * during SSR or tests where `document` is absent. Nothing is sent anywhere.
 */
export function downloadBlob(blob: Blob, filename: string): void {
	if (typeof document === "undefined") return;
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
