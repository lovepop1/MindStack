import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// GET /api/workspaces/debug
// Diagnostic endpoint to check workspace table structure and permissions
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        // Get user info
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Try to query workspaces table
        const { data: workspaces, error: workspacesError } = await supabase
            .from("workspaces")
            .select("*")
            .limit(1);

        // Try to query workspace_members table
        const { data: members, error: membersError } = await supabase
            .from("workspace_members")
            .select("*")
            .limit(1);

        return NextResponse.json({
            user_id: user.id,
            user_email: user.email,
            workspaces_query: {
                success: !workspacesError,
                error: workspacesError?.message,
                details: workspacesError?.details,
                hint: workspacesError?.hint,
                code: workspacesError?.code,
                data_count: workspaces?.length ?? 0,
            },
            workspace_members_query: {
                success: !membersError,
                error: membersError?.message,
                details: membersError?.details,
                hint: membersError?.hint,
                code: membersError?.code,
                data_count: members?.length ?? 0,
            },
        });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[GET /api/workspaces/debug]", err);
        return NextResponse.json(
            { error: "Internal server error", details: String(err) },
            { status: 500 }
        );
    }
}
