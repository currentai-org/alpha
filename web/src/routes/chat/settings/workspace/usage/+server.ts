// "counts only... structurally enforced, not just a UI choice." The workspace settings page
// only ever SHOWS this to an admin, but that's a UI choice on its own — this endpoint independently
// re-verifies the caller is an admin OF THIS ORGANIZATION before returning anything, the same
// per-request discipline CUR-412 built for bucket paths ("a users/<id>/ layout is organisation, not
// access control" — the workspace equivalent is "an admin-only UI is not an authorization check").
//
// Also gated on workspacesEnabled(), same as every other workspace surface — this route talks
// straight to Drizzle rather than through Better Auth's organization plugin, so it never passes
// through the organization-route 404 in routes/chat/api/auth/[...all]/+server.ts (CUR-917). (CUR-552)
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { eq } from "drizzle-orm";
import { getAuth } from "$lib/chat/server/betterAuth";
import { getDb } from "$lib/chat/server/db/client";
import { member } from "$lib/chat/server/db/schema";
import { getWorkspaceUsage } from "$lib/chat/server/workspaceUsage";
import { workspacesEnabled } from "$lib/chat/server/workspacesGate";

export async function GET({ request, url }) {
	if (!workspacesEnabled()) error(404, "Not found");

	const organizationId = url.searchParams.get("organizationId");
	if (!organizationId) error(400, "organizationId is required");

	const session = await getAuth().api.getSession({ headers: request.headers });
	if (!session) error(401, "Not signed in");

	const members = await getDb()
		.select({ userId: member.userId, role: member.role })
		.from(member)
		.where(eq(member.organizationId, organizationId));

	const caller = members.find((m) => m.userId === session.user.id);
	const callerIsAdmin = caller?.role.split(",").includes("admin") ?? false;
	if (!callerIsAdmin) error(403, "Only a workspace admin can see usage");

	const usage = await getWorkspaceUsage(
		members.map((m) => m.userId),
		organizationId
	);
	return json(usage);
}
