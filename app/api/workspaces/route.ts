import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

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
            .select(`
                workspace_id,
                role,
                display_name,
                joined_at,
                workspaces ( id, name, join_code, created_by, created_at )
            `)
            .eq("user_id", user.id)
            .order("joined_at", { ascending: false });

        if (memberError) {
            return NextResponse.json({ error: memberError.message }, { status: 500 });
        }

        // =======================================================================
        // UNIVERSAL MAPPING: Satisfy both the Web Dashboard and the IDE Extension
        // =======================================================================
        const workspaces = (memberships ?? []).map((m) => {
            const workspace = Array.isArray(m.workspaces) ? m.workspaces[0] : m.workspaces;
            
            return {
                // Keys required by the Next.js Web Dashboard
                id: m.workspace_id,
                role: m.role,
                display_name: m.display_name,
                
                // Legacy keys the IDE Extension might be looking for
                workspace_id: m.workspace_id,
                user_role: m.role,
                user_display_name: m.display_name,
                
                // Shared data (with fallback strings to prevent invisible HTML elements)
                name: workspace?.name || "Unnamed Workspace", 
                join_code: workspace?.join_code,
                created_at: workspace?.created_at,
            };
        });

        // =======================================================================
        // UNIVERSAL WRAPPER: Defeat the IDE's "aggressive parser"
        // =======================================================================
        // - The web dashboard expects `data.workspaces`.
        // - The IDE likely expects `data.data` or `data.projects` based on your earlier description.
        return NextResponse.json({ 
            workspaces: workspaces, 
            data: workspaces,      
            projects: workspaces   
        });

    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[GET /api/workspaces]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}