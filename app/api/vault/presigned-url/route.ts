import { NextRequest, NextResponse } from "next/server";
import { extractJwt } from "@/lib/supabase";
import { getPutPresignedUrl } from "@/lib/s3";

// ---------------------------------------------------------------------------
// POST /api/vault/presigned-url
// Body: { file_name: string, file_type: string }
// Returns a 15-minute S3 PUT presigned URL and the resulting S3 object URL.
// The client should upload the file directly to S3, then store the s3_url
// as a capture_attachment record.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        // Require auth — even though the presigned URL is tied to IAM credentials,
        // we reject unauthenticated callers to prevent abuse.
        extractJwt(req);

        const body = await req.json();
        const { file_name, file_type } = body as {
            file_name?: string;
            file_type?: string;
        };

        if (!file_name || !file_name.trim()) {
            return NextResponse.json({ error: "`file_name` is required" }, { status: 400 });
        }
        if (!file_type || !file_type.trim()) {
            return NextResponse.json({ error: "`file_type` is required" }, { status: 400 });
        }

        const { uploadUrl, s3Url } = await getPutPresignedUrl(
            file_name.trim(),
            file_type.trim()
        );

        return NextResponse.json({ upload_url: uploadUrl, s3_url: s3Url });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/vault/presigned-url]", err);
        return NextResponse.json({ error: "Failed to generate presigned URL" }, { status: 500 });
    }
}
