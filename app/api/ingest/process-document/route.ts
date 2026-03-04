import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { invokeTitanEmbedding } from "@/lib/bedrock";
import { chunkText } from "@/lib/chunker";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

// ---------------------------------------------------------------------------
// POST /api/ingest/process-document
// Triggered after a PDF is uploaded to S3.
// Body: { capture_id: string, project_id?: string, workspace_id?: string, s3_url: string }
// Fetches PDF from S3, parses text, chunks, embeds, saves to capture_chunks.
// Uses the admin client throughout — this is a background server-side task.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        // Resolve the user_id from the JWT to verify workspace membership
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { capture_id, project_id, workspace_id, s3_url } = body as {
            capture_id?: string;
            project_id?: string;
            workspace_id?: string;
            s3_url?: string;
        };

        if (!capture_id || !s3_url) {
            return NextResponse.json(
                { error: "`capture_id` and `s3_url` are required" },
                { status: 400 }
            );
        }

        // Must have either project_id OR workspace_id
        if (!project_id && !workspace_id) {
            return NextResponse.json(
                { error: "Either `project_id` or `workspace_id` is required" },
                { status: 400 }
            );
        }

        // -- Attribution Lookup (for workspace mode) ----------------------------
        let author_display_name: string | null = null;
        if (workspace_id) {
            const { data: member, error: memberError } = await supabase
                .from("workspace_members")
                .select("display_name")
                .eq("workspace_id", workspace_id)
                .eq("user_id", user.id)
                .single();

            if (memberError || !member) {
                return NextResponse.json(
                    { error: "User is not a member of this workspace" },
                    { status: 403 }
                );
            }

            author_display_name = member.display_name;
        }

        // Respond immediately and process asynchronously
        const response = NextResponse.json({ success: true, capture_id });

        processDocumentAsync({
            capture_id,
            project_id: project_id ?? null,
            workspace_id: workspace_id ?? null,
            author_display_name,
            s3_url
        }).catch((err) =>
            console.error(`[ingest/process-document] Async failed for ${capture_id}:`, err)
        );

        return response;
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/ingest/process-document]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// ---------------------------------------------------------------------------
// Async pipeline: S3 fetch → pdf-parse → chunk → embed → save
// ---------------------------------------------------------------------------
async function processDocumentAsync(args: {
    capture_id: string;
    project_id: string | null;
    workspace_id: string | null;
    author_display_name: string | null;
    s3_url: string;
}): Promise<void> {
    const admin = createAdminClient();
    const BUCKET = process.env.NEXT_PUBLIC_AWS_S3_BUCKET_NAME!;

    // -- Fetch PDF bytes from S3 ----------------------------------------------
    const s3 = new S3Client({
        region: process.env.NEXT_PUBLIC_AWS_REGION!,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
    });

    let pdfBuffer: Buffer;
    try {
        const url = new URL(args.s3_url);
        let key: string;
        if (url.hostname.startsWith(`${BUCKET}.`)) {
            key = url.pathname.slice(1);
        } else {
            key = url.pathname.split("/").slice(2).join("/");
        }

        const s3Response = await s3.send(
            new GetObjectCommand({ Bucket: BUCKET, Key: key })
        );

        if (!s3Response.Body) {
            throw new Error("Empty S3 response body");
        }

        const chunks: Uint8Array[] = [];
        for await (const chunk of s3Response.Body as Readable) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        pdfBuffer = Buffer.concat(chunks);
    } catch (s3Err) {
        console.error(`[process-document] S3 fetch failed for ${args.s3_url}:`, s3Err);
        return;
    }

    // -- Parse PDF text -------------------------------------------------------
    let pdfText = "";
    try {
        // pdf-parse is a CommonJS module — require() to avoid ESM issues
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pdfParse = require("pdf-parse") as (
            data: Buffer
        ) => Promise<{ text: string; numpages: number }>;
        const parsed = await pdfParse(pdfBuffer);
        pdfText = parsed.text;
    } catch (parseErr) {
        console.error(`[process-document] PDF parse failed for capture ${args.capture_id}:`, parseErr);
        return;
    }

    if (!pdfText || pdfText.trim().length === 0) {
        console.log(`[process-document] No extractable text in PDF for capture ${args.capture_id}`);
        return;
    }

    // -- Chunk + Embed + Save -------------------------------------------------
    const chunks = chunkText(pdfText);
    if (chunks.length === 0) return;

    const chunkRows: {
        capture_id: string;
        project_id: string | null;
        workspace_id: string | null;
        chunk_text: string;
        embedding: number[];
        chunk_index: number;
    }[] = [];

    for (let i = 0; i < chunks.length; i++) {
        try {
            // CRITICAL: Prepend author attribution for workspace captures
            let chunkTextData = chunks[i];
            if (args.workspace_id && args.author_display_name) {
                chunkTextData = `[Contributed by: ${args.author_display_name}]\n\n${chunks[i]}`;
            }

            const embedding = await invokeTitanEmbedding(chunkTextData);
            chunkRows.push({
                capture_id: args.capture_id,
                project_id: args.project_id,
                workspace_id: args.workspace_id,
                chunk_text: chunkTextData,
                embedding,
                chunk_index: i,
            });
        } catch (embedErr) {
            console.error(
                `[process-document] Embedding failed for chunk ${i} of capture ${args.capture_id}:`,
                embedErr
            );
        }
    }

    if (chunkRows.length > 0) {
        const { error } = await admin.from("capture_chunks").insert(chunkRows);
        if (error) {
            console.error(
                `[process-document] Chunk insert failed for capture ${args.capture_id}:`,
                error
            );
        } else {
            console.log(
                `[process-document] Saved ${chunkRows.length} chunks for capture ${args.capture_id}`
            );
        }
    }
}