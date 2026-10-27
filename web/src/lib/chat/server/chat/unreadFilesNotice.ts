import type { PreparedTurnMedia } from "./prepareTurnMedia";

/** The line the turn shows for files it could not read (CUR-3291), or undefined when it read them all. */
export function unreadFilesNotice(unread: PreparedTurnMedia["unreadFiles"]): string | undefined {
	const names = (reason: "unreadable" | "missing") =>
		unread.filter((f) => f.reason === reason).map((f) => `"${f.name}"`);
	const them = (n: string[]) => (n.length === 1 ? "it" : "them");
	const unreadable = names("unreadable");
	const missing = names("missing");
	const lines = [
		unreadable.length
			? `Couldn't read ${unreadable.join(", ")} from storage just now, so this answer doesn't use ${them(unreadable)}. Send your message again to retry.`
			: "",
		missing.length ? `Couldn't find ${missing.join(", ")}, so this answer doesn't use ${them(missing)}.` : "",
	].filter(Boolean);
	return lines.length ? lines.join(" ") : undefined;
}
