import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";
import { getPresignedGetUrl } from "@/lib/s3";

interface RouteParams {
    params: { project_id: string };
}

// ---------------------------------------------------------------------------
// GET /api/projects/[project_id]/captures
// Returns all captures + their attachments for a given project.
// Attachment s3_url values are replaced with 1-hour pre-signed GET URLs so
// the private S3 bucket never returns 403 to the browser.
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
        text_content,
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

        // Replace each attachment's stored raw S3 URL with a fresh pre-signed
        // GET URL (1-hour TTL). Run per-capture in parallel for performance.
        const captures = data ?? [];
        await Promise.all(
            captures.map(async (capture) => {
                const attachments = (capture.capture_attachments as Array<{ s3_url: string }>) ?? [];
                await Promise.all(
                    attachments.map(async (att) => {
                        if (att.s3_url) {
                            try {
                                att.s3_url = await getPresignedGetUrl(att.s3_url);
                            } catch (signErr) {
                                console.warn(
                                    `[GET /api/projects/${project_id}/captures] Failed to sign URL: ${att.s3_url}`,
                                    signErr
                                );
                                // Leave the original URL — the browser will see a 403, but
                                // one failed signature won't break the whole response.
                            }
                        }
                    })
                );
            })
        );

        return NextResponse.json({ captures });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error(`[GET /api/projects/${params?.project_id}/captures]`, err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
