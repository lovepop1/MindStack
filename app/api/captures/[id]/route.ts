import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";
import { deleteS3Object } from "@/lib/s3";

interface RouteParams {
    params: { id: string };
}

// ---------------------------------------------------------------------------
// DELETE /api/captures/[id]
// 1. Fetch all capture_attachments to get S3 URLs.
// 2. Delete each S3 object (best-effort; log failures but continue).
// 3. Delete the DB row — cascades to capture_attachments and capture_chunks.
// ---------------------------------------------------------------------------
export async function DELETE(req: NextRequest, { params }: RouteParams) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);
        const { id } = params;

        if (!id) {
            return NextResponse.json({ error: "`id` is required" }, { status: 400 });
        }

        // Fetch attachments first (they will be cascade-deleted from DB, so we
        // need the S3 URLs before the row disappears)
        const { data: attachments, error: fetchError } = await supabase
            .from("capture_attachments")
            .select("s3_url")
            .eq("capture_id", id);

        if (fetchError) {
            return NextResponse.json({ error: fetchError.message }, { status: 500 });
        }

        // Best-effort S3 cleanup — don't abort if an object is already gone
        const s3Deletions = (attachments ?? []).map(async (att) => {
            try {
                await deleteS3Object(att.s3_url);
            } catch (s3Err) {
                console.warn(`[DELETE /api/captures/${id}] S3 cleanup failed for ${att.s3_url}:`, s3Err);
            }
        });
        await Promise.allSettled(s3Deletions);

        // Delete DB row (cascade handles capture_attachments + capture_chunks)
        const { error: deleteError } = await supabase
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
