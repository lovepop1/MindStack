import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { invokeClaudeHaiku } from "@/lib/bedrock";

// ---------------------------------------------------------------------------
// POST /api/sessions/end
// Body: { session_id: string }
// Sync: sets end_time.
// Async: builds an ai_debrief by collating all capture summaries and asking
//        Haiku to synthesize a coherent session debrief. Uses the admin client
//        so the async work doesn't require a still-valid user JWT.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        const body = await req.json();
        const { session_id } = body as { session_id?: string };

        if (!session_id) {
            return NextResponse.json({ error: "`session_id` is required" }, { status: 400 });
        }

        // -- Synchronous: stamp end_time ----------------------------------------
        const { error: updateError } = await supabase
            .from("sessions")
            .update({ end_time: new Date().toISOString() })
            .eq("id", session_id);

        if (updateError) {
            return NextResponse.json({ error: updateError.message }, { status: 500 });
        }

        // -- Respond immediately so the extension isn't blocked ------------------
        const response = NextResponse.json({ success: true });

        // -- Async: generate ai_debrief without blocking the response ------------
        generateDebriefAsync(session_id).catch((err) =>
            console.error(`[sessions/end] Async debrief failed for ${session_id}:`, err)
        );

        return response;
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/sessions/end]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// ---------------------------------------------------------------------------
// Background: collate capture summaries → Haiku → save ai_debrief
// ---------------------------------------------------------------------------
async function generateDebriefAsync(session_id: string): Promise<void> {
    const admin = createAdminClient();

    // Fetch all non-null AI summaries from this session's captures
    const { data: captures, error } = await admin
        .from("captures")
        .select("ai_markdown_summary, capture_type, created_at")
        .eq("session_id", session_id)
        .not("ai_markdown_summary", "is", null)
        .order("created_at", { ascending: true });

    if (error || !captures || captures.length === 0) {
        console.log(`[sessions/end] No summaries to debrief for session ${session_id}`);
        return;
    }

    const summariesText = captures
        .map(
            (c, i) =>
                `### Capture ${i + 1} (${c.capture_type})\n${c.ai_markdown_summary}`
        )
        .join("\n\n---\n\n");

    const prompt = `You are a developer's learning assistant. Below are AI-generated summaries of all knowledge captures from a single coding/research session.

Your task is to synthesize these into a concise, well-structured **Session Debrief** in Markdown. The debrief should:
- Summarize the key topics explored and problems solved
- Highlight important insights or learnings
- Note any unresolved questions or next steps

Keep it under 400 words.

---

${summariesText}`;

    const debrief = await invokeClaudeHaiku(prompt);

    // Save debrief back to the session using the admin client
    const { error: saveError } = await admin
        .from("sessions")
        .update({ ai_debrief: debrief })
        .eq("id", session_id);

    if (saveError) {
        console.error(`[sessions/end] Failed to save debrief for ${session_id}:`, saveError);
    }
}
