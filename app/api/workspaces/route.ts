import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// 1. MUST ADD THIS TO PREVENT AGGRESSIVE CACHING
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export async function GET(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

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

        // 2. FIXED MAPPING TO MATCH FRONTEND INTERFACE EXACTLY
        const workspaces = (memberships ?? []).map((m) => {
            const workspace = Array.isArray(m.workspaces) ? m.workspaces[0] : m.workspaces;
            return {
                id: m.workspace_id,             // Fixed from workspace_id
                name: workspace?.name,
                join_code: workspace?.join_code,
                role: m.role,                   // Fixed from user_role
                display_name: m.display_name,   // Fixed from user_display_name
                created_at: workspace?.created_at,
            };
        });

        // 3. We are returning an object { workspaces: [...] }
        return NextResponse.json({ workspaces });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[GET /api/workspaces]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}