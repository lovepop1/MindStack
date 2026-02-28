import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

interface RouteParams {
    params: { project_id: string };
}

// ---------------------------------------------------------------------------
// GET /api/projects/[project_id]/captures
// Returns all captures + their attachments for a given project.
// Ordered by created_at DESC for timeline rendering.
// RLS ensures the user can only see their own project's data.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, { params }: RouteParams) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);
        const { project_id } = params;

        if (!project_id) {
            return NextResponse.json({ error: "`project_id` is required" }, { status: 400 });
        }

        const { data, error } = await supabase
            .from("captures")
            .select(
                `
        id,
        session_id,
        project_id,
        capture_type,
        priority,
        source_url,
        page_title,
        video_start_time,
        video_end_time,
        ide_error_log,
        ide_code_diff,
        ide_file_path,
        ai_markdown_summary,
        created_at,
        capture_attachments (
          id,
          s3_url,
          file_type,
          file_name
        )
        `
            )
            .eq("project_id", project_id)
            .order("created_at", { ascending: false });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ captures: data });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error(`[GET /api/projects/${params?.project_id}/captures]`, err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
