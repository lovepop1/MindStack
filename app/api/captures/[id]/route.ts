import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { deleteS3Object } from "@/lib/s3";

interface RouteParams {
    params: { id: string };
}

// ---------------------------------------------------------------------------
// DELETE /api/captures/[id]
// 1. Verify user has permission (owns capture OR is workspace admin OR is personal project).
// 2. Fetch all capture_attachments to get S3 URLs.
// 3. Delete each S3 object (best-effort; log failures but continue).
// 4. Delete the DB row — cascades to capture_attachments and capture_chunks.
// ---------------------------------------------------------------------------
export async function DELETE(req: NextRequest, { params }: RouteParams) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);
        const { id } = params;

        if (!id) {
            return NextResponse.json({ error: "`id` is required" }, { status: 400 });
        }

        // Get current user ID
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Fetch the capture to check ownership and workspace
        const { data: capture, error: captureError } = await supabase
            .from("captures")
            .select("author_id, workspace_id")
            .eq("id", id)
            .single();

        if (captureError || !capture) {
            return NextResponse.json({ error: "Capture not found" }, { status: 404 });
        }

        let hasPermission = false;

        // --- NEW PERMISSION LOGIC ---
        if (capture.workspace_id) {
            // SCENARIO A: It is a Team Workspace Capture
            if (capture.author_id === user.id) {
                hasPermission = true; // They are the author
            } else {
                // Check if user is an ADMIN in this workspace
                const { data: membership } = await supabase
                    .from("workspace_members")
                    .select("role")
                    .eq("workspace_id", capture.workspace_id)
                    .eq("user_id", user.id)
                    .single();

                if (membership?.role === "ADMIN") {
                    hasPermission = true;
                }
            }
        } else {
            // SCENARIO B: It is a Personal Project Capture
            // If the user's RLS allowed them to SELECT it above, they own the project.
            // We allow deletion if author_id matches, OR if author_id is null (legacy captures).
            if (capture.author_id === user.id || capture.author_id === null) {
                hasPermission = true;
            }
        }

        if (!hasPermission) {
            return NextResponse.json(
                { error: "You don't have permission to delete this capture" },
                { status: 403 }
            );
        }

        // Fetch attachments first (they will be cascade-deleted from DB)
        const { data: attachments, error: fetchError } = await supabase
            .from("capture_attachments")
            .select("s3_url")
            .eq("capture_id", id);

        if (fetchError) {
            return NextResponse.json({ error: fetchError.message }, { status: 500 });
        }

        // Best-effort S3 cleanup
        const s3Deletions = (attachments ?? []).map(async (att) => {
            try {
                await deleteS3Object(att.s3_url);
            } catch (s3Err) {
                console.warn(`[DELETE /api/captures/${id}] S3 cleanup failed for ${att.s3_url}:`, s3Err);
            }
        });
        await Promise.allSettled(s3Deletions);

        // ==========================================
        // HERE IS THE FIX: Using the Admin Client
        // ==========================================
        const adminSupabase = createAdminClient();

        // Delete DB row using the admin client
        const { error: deleteError } = await adminSupabase
            .from("captures")
            .delete()
            .eq("id", id);

        if (deleteError) {
            return NextResponse.json({ error: deleteError.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error(`[DELETE /api/captures/${params?.id}]`, err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}