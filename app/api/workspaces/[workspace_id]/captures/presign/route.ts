import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";
import { getPutPresignedUrl } from "@/lib/s3";

interface RouteParams {
    params: { workspace_id: string };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);
        const { workspace_id } = params;

        if (!workspace_id) {
            return NextResponse.json({ error: "`workspace_id` is required" }, { status: 400 });
        }

        const filename = req.nextUrl.searchParams.get("filename");
        const contentType = req.nextUrl.searchParams.get("contentType");

        if (!filename || !contentType) {
            return NextResponse.json(
                { error: "Both `filename` and `contentType` query parameters are required" },
                { status: 400 }
            );
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

        // Generate the presigned PUT url
        const { uploadUrl, s3Url } = await getPutPresignedUrl(filename, contentType);

        // Extract the key from the generated s3Url (which is virtual-hosted style from getPutPresignedUrl)
        const urlObj = new URL(s3Url);
        const key = urlObj.pathname.slice(1); // Removes the leading '/'

        return NextResponse.json({
            url: uploadUrl,
            key: key
        });
    } catch (err) {
        if (err instanceof Response) return err; // e.g., Auth failures
        console.error(`[GET /api/workspaces/${params?.workspace_id}/captures/presign]`, err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
