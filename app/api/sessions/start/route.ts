import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// POST /api/sessions/start
// Body: { project_id?: string, workspace_id?: string }
// Creates a new session tied to a project OR workspace and returns the session_id.
// Supports dual routing: personal projects OR team workspaces.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        const body = await req.json();
        const { project_id, workspace_id } = body as {
            project_id?: string;
            workspace_id?: string;
        };

        // Must have either project_id OR workspace_id
        if (!project_id && !workspace_id) {
            return NextResponse.json(
                { error: "Either `project_id` or `workspace_id` is required" },
                { status: 400 }
            );
        }

        const { data, error } = await supabase
            .from("sessions")
            .insert({
                project_id: project_id ?? null,
                workspace_id: workspace_id ?? null,
                start_time: new Date().toISOString(),
                last_active_at: new Date().toISOString(),
            })
            .select("id")
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ session_id: data.id }, { status: 201 });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/sessions/start]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
