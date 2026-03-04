import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// GET /api/workspaces
// Returns all workspaces where the authenticated user is a member.
// Includes workspace details and the user's role in each workspace.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        // Resolve the user_id from the JWT
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Fetch all workspace memberships for this user
        const { data: memberships, error: memberError } = await supabase
            .from("workspace_members")
            .select(
                `
                workspace_id,
                role,
                display_name,
                joined_at,
                workspaces (
                    id,
                    name,
                    join_code,
                    created_by,
                    created_at
                )
            `
            )
            .eq("user_id", user.id)
            .order("joined_at", { ascending: false });

        if (memberError) {
            return NextResponse.json({ error: memberError.message }, { status: 500 });
        }

        // Transform the response to a cleaner structure
        const workspaces = (memberships ?? []).map((m) => {
            const workspace = Array.isArray(m.workspaces) ? m.workspaces[0] : m.workspaces;
            return {
                workspace_id: m.workspace_id,
                name: workspace?.name,
                join_code: workspace?.join_code,
                created_by: workspace?.created_by,
                created_at: workspace?.created_at,
                user_role: m.role,
                user_display_name: m.display_name,
                joined_at: m.joined_at,
            };
        });

        return NextResponse.json({ workspaces });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[GET /api/workspaces]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
