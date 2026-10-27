// One copy path for every Copy control. The Clipboard API first; when it is missing (an
// insecure context) or refuses (a blocked permission, an embed), the old execCommand path. Resolves
// false only when both refuse, so the caller can say it couldn't copy instead of doing nothing. (CUR-2823)
export async function writeClipboard(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// fall through to the execCommand path
		}
	}
	return execCommandCopy(text);
}

function execCommandCopy(text: string): boolean {
	if (typeof document === "undefined") return false;
	const textArea = document.createElement("textarea");
	textArea.value = text;
	textArea.setAttribute("readonly", "");
	textArea.style.position = "fixed";
	textArea.style.opacity = "0";
	document.body.appendChild(textArea);
	textArea.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		document.body.removeChild(textArea);
	}
}
