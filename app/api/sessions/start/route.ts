import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// POST /api/sessions/start
// Body: { project_id: string }
// Creates a new session tied to a project and returns the session_id.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        const body = await req.json();
        const { project_id } = body as { project_id?: string };

        if (!project_id) {
            return NextResponse.json({ error: "`project_id` is required" }, { status: 400 });
        }

        const { data, error } = await supabase
            .from("sessions")
            .insert({
                project_id,
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
