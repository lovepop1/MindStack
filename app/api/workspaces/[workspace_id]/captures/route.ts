import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";
import { getPresignedGetUrl } from "@/lib/s3";

interface RouteParams {
    params: { workspace_id: string };
}

// ---------------------------------------------------------------------------
// GET /api/workspaces/[workspace_id]/captures
// Returns all captures + their attachments for a given workspace.
// Attachment s3_url values are replaced with 1-hour pre-signed GET URLs so
// the private S3 bucket never returns 403 to the browser.
// Ordered by created_at DESC for timeline rendering.
// RLS ensures the user can only see captures from workspaces they're members of.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, { params }: RouteParams) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);
        const { workspace_id } = params;

        if (!workspace_id) {
            return NextResponse.json({ error: "`workspace_id` is required" }, { status: 400 });
        }

        // Verify the user is a member of this workspace
        const { data: membership, error: membershipError } = await supabase
            .from("workspace_members")
            .select("workspace_id")
            .eq("workspace_id", workspace_id)
            .single();

        if (membershipError || !membership) {
            return NextResponse.json(
                { error: "Workspace not found or access denied" },
                { status: 404 }
            );
        }

        const { data, error } = await supabase
            .from("captures")
            .select(
                `
        id,
        session_id,
        workspace_id,
        author_id,
        author_display_name,
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
            .eq("workspace_id", workspace_id)
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
                                    `[GET /api/workspaces/${workspace_id}/captures] Failed to sign URL: ${att.s3_url}`,
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
        console.error(`[GET /api/workspaces/${params?.workspace_id}/captures]`, err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
