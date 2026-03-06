import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { invokeTitanEmbedding } from "@/lib/bedrock"; // Removed Haiku import
import { chunkText } from "@/lib/chunker";

// ---------------------------------------------------------------------------
// Allowed capture types for browser ingestion
// ---------------------------------------------------------------------------
type BrowserCaptureType =
    | "WEB_TEXT"
    | "VIDEO_SEGMENT"
    | "USER_NOTE"
    | "RESOURCE_UPLOAD";

interface Attachment {
    s3_url: string;
    file_type: "PDF" | "IMAGE" | "VIDEO_KEYFRAME" | "RAW_TRANSCRIPT_JSON" | "DOC";
    file_name: string;
}

// ---------------------------------------------------------------------------
// POST /api/ingest/browser
// Sync: Insert capture + attachments, return 200.
// Async: Fetch YouTube transcript (VIDEO_SEGMENT),
//        chunk & embed raw text with Titan, bulk-insert capture_chunks.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);
        const adminSupabase = createAdminClient();

        // Resolve the user_id from the JWT
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const {
            session_id,
            project_id,
            workspace_id,
            capture_type,
            text_content,
            caption_text,
            source_url,
            page_title,
            video_start_time,
            video_end_time,
            priority,
            attachments,
        } = body as {
            session_id?: string;
            project_id?: string;
            workspace_id?: string;
            capture_type?: BrowserCaptureType;
            text_content?: string;
            caption_text?: string;
            source_url?: string;
            page_title?: string;
            video_start_time?: number;
            video_end_time?: number;
            priority?: number;
            attachments?: Attachment[];
        };

        const final_text_content = text_content || caption_text || null;

        // -- Validate required fields -------------------------------------------
        if (!session_id || !capture_type) {
            return NextResponse.json(
                { error: "`session_id` and `capture_type` are required" },
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

        const validTypes: BrowserCaptureType[] = [
            "WEB_TEXT",
            "VIDEO_SEGMENT",
            "USER_NOTE",
            "RESOURCE_UPLOAD",
        ];
        if (!validTypes.includes(capture_type)) {
            return NextResponse.json({ error: `Invalid capture_type: ${capture_type}` }, { status: 400 });
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

        // -- Sync: Insert capture row -------------------------------------------
        const { data: captureRow, error: captureError } = await supabase
            .from("captures")
            .insert({
                session_id,
                project_id: project_id ?? null,
                workspace_id: workspace_id ?? null,
                author_id: workspace_id ? user.id : null,
                author_display_name: author_display_name,
                capture_type,
                source_url: source_url ?? null,
                page_title: page_title ?? null,
                text_content: final_text_content,
                ai_markdown_summary: null, // Explicitly null since we removed Haiku
                video_start_time: video_start_time ?? null,
                video_end_time: video_end_time ?? null,
                priority: priority ?? 0,
            })
            .select("id")
            .single();

        if (captureError || !captureRow) {
            return NextResponse.json({ error: captureError?.message ?? "Insert failed" }, { status: 500 });
        }

        const capture_id = captureRow.id;

        // -- Sync: Insert attachments (if any) ------------------------------------
        if (attachments && attachments.length > 0) {
            const attachmentRows = attachments.map((a) => ({
                capture_id,
                s3_url: a.s3_url,
                file_type: a.file_type,
                file_name: a.file_name,
            }));

            const { error: attError } = await adminSupabase
                .from("capture_attachments")
                .insert(attachmentRows);

            if (attError) {
                console.error(`[ingest/browser] Attachment insert failed for capture ${capture_id}:`, attError);
                // Non-fatal: capture was created, just log the error
            }
        }

        // -- Respond immediately -----------------------------------------------
        const response = NextResponse.json({ capture_id }, { status: 200 });

        const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
        const proto = req.headers.get("x-forwarded-proto") || "http";
        const requestOrigin = `${proto}://${host}`;

        // -- Async: Embed pipeline (Wait for Vercel Serverless to finish) ------
        await processBrowserCaptureAsync({
            capture_id,
            project_id: project_id ?? null,
            workspace_id: workspace_id ?? null,
            author_display_name,
            capture_type,
            text_content: final_text_content ?? "",
            caption_text,
            source_url: source_url ?? "",
            page_title: page_title ?? null, // 🚨 Now properly passed to async function
            video_start_time,
            video_end_time,
            attachments,
            requestOrigin,
        }).catch((err) =>
            console.error(`[ingest/browser] Async pipeline failed for ${capture_id}:`, err)
        );

        return response;
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/ingest/browser]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// ---------------------------------------------------------------------------
// Async pipeline
// ---------------------------------------------------------------------------
async function processBrowserCaptureAsync(args: {
    capture_id: string;
    project_id: string | null;
    workspace_id: string | null;
    author_display_name: string | null;
    capture_type: BrowserCaptureType;
    text_content: string;
    caption_text?: string;
    source_url: string;
    page_title?: string | null; // 🚨 Added to signature
    video_start_time?: number;
    video_end_time?: number;
    attachments?: { file_type: string; file_name: string }[];
    requestOrigin?: string;
}): Promise<void> {
    const admin = createAdminClient();
    let fullText = args.text_content;
    let transcriptTextForPrompt = args.caption_text || "";

    // -- Step 1: Fetch YouTube transcript for VIDEO_SEGMENT -------------------
    if (args.capture_type === "VIDEO_SEGMENT" && args.source_url) {
        try {
            const videoId = extractYoutubeVideoId(args.source_url);
            if (videoId) {
                // Fetch from the Standalone Python Microservice
                const baseUrl = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";
                let url = `${baseUrl}/api/transcript?v=${videoId}`;

                // Pass precise timestamps to the microservice so it can slice the transcript for exact context.
                if (args.video_start_time !== undefined && args.video_end_time !== undefined) {
                    url += `&start=${args.video_start_time}&end=${args.video_end_time}`;
                }

                try {
                    const response = await fetch(url);
                    const data = await response.json();

                    if (data.transcript) {
                        const transcriptText = data.transcript;
                        console.log(`[ingest/browser] Successfully fetched python-service transcript for ${args.source_url}`);

                        // Override the DOM provided transcript with the guaranteed accurate Python one
                        transcriptTextForPrompt = transcriptText;

                        // Replace the appended DOM transcript inside fullText if it exists
                        if (args.caption_text) {
                            fullText = args.text_content.replace(args.caption_text, "").trim();
                        }

                        fullText = fullText
                            ? `${fullText}\n\n[Transcript]\n${transcriptText}`
                            : transcriptText;
                    } else if (data.error) {
                        console.warn(`[ingest/browser] Vercel Python API returned error:`, data.error);
                        console.log(`[ingest/browser] Falling back to client-provided transcript.`);
                    }
                } catch (fetchErr) {
                    console.error(`[ingest/browser] Error calling Vercel transcript API:`, fetchErr);
                    console.log(`[ingest/browser] Falling back to client-provided transcript.`);
                }
            }
        } catch (transcriptErr) {
            // Graceful fallback — transcripts may be disabled
            console.warn(
                `[ingest/browser] YouTube transcript fetch failed for ${args.source_url}:`,
                transcriptErr
            );
        }
    }

    // -- Step 1.5: Append Media Metadata for RAG ------------------------------
    // If the capture has images or PDFs, append a textual description so the embedder 
    // knows this capture contains visual media. This fixes "blind" RAG image searches.
    if (args.attachments && args.attachments.length > 0) {
        const mediaDescriptions = args.attachments.map(
            (att) => `[Attached Media: ${att.file_name} (${att.file_type})]`
        );
        fullText += `\n\n${mediaDescriptions.join("\n")}`;
    }

    if (!fullText || fullText.trim().length === 0) {
        console.log(`[ingest/browser] No text content for capture ${args.capture_id}, skipping embed`);
        return;
    }

    // -- Update text_content with the final merged text (may include transcript)
    try {
        await admin
            .from("captures")
            .update({ text_content: fullText })
            .eq("id", args.capture_id);
    } catch (updateErr) {
        console.warn(`[ingest/browser] text_content update failed for ${args.capture_id}:`, updateErr);
        // Non-fatal — the initial text_content from the insert is still available
    }

    // -- Step 2: Chunk + Embed + Save (Directly on fullText) ------------------
    const textToEmbed = fullText;
    const chunks = chunkText(textToEmbed);

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
            // 🚨 APPLIED FIX: Advanced descriptive chunk header
            let metadataHeader = `[Context: Saved ${args.capture_type.replace(/_/g, " ")}]`;
            if (args.page_title) {
                metadataHeader += `\n[Source Title: ${args.page_title}]`;
            }
            if (args.workspace_id && args.author_display_name) {
                metadataHeader += `\n[Contributed by: ${args.author_display_name}]`;
            }

            const chunkTextData = `${metadataHeader}\n\n${chunks[i]}`;
            
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
                `[ingest/browser] Embedding failed for chunk ${i} of ${args.capture_id}:`,
                embedErr
            );
        }
    }

    if (chunkRows.length > 0) {
        const { error } = await admin.from("capture_chunks").insert(chunkRows);
        if (error) {
            console.error(`[ingest/browser] Chunk insert failed for ${args.capture_id}:`, error);
        }
    }
}

// ---------------------------------------------------------------------------
// Extract YouTube video ID from various URL formats
// ---------------------------------------------------------------------------
function extractYoutubeVideoId(url: string): string | null {
    try {
        const u = new URL(url);
        // Standard: youtube.com/watch?v=VIDEO_ID
        if (u.hostname.includes("youtube.com")) {
            return u.searchParams.get("v");
        }
        // Short: youtu.be/VIDEO_ID
        if (u.hostname === "youtu.be") {
            return u.pathname.slice(1) || null;
        }
    } catch {
        // Malformed URL
    }
    return null;
}