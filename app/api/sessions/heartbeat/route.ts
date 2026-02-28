import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// POST /api/sessions/heartbeat
// Body: { session_id: string, active_file_context?: string }
// Updates last_active_at and optionally sets the current active file.
// Called periodically by IDE/browser extensions while a session is running.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        const body = await req.json();
        const { session_id, active_file_context } = body as {
            session_id?: string;
            active_file_context?: string;
        };

        if (!session_id) {
            return NextResponse.json({ error: "`session_id` is required" }, { status: 400 });
        }

        const updatePayload: Record<string, unknown> = {
            last_active_at: new Date().toISOString(),
        };

        if (typeof active_file_context === "string") {
            updatePayload.active_file_context = active_file_context;
        }

        const { error } = await supabase
            .from("sessions")
            .update(updatePayload)
            .eq("id", session_id);

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/sessions/heartbeat]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
