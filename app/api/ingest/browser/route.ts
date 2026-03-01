import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { invokeClaudeHaiku, invokeTitanEmbedding } from "@/lib/bedrock";
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
// Async: Fetch YouTube transcript (VIDEO_SEGMENT), summarize via Haiku,
//        chunk & embed with Titan, bulk-insert capture_chunks.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        const body = await req.json();
        const {
            session_id,
            project_id,
            capture_type,
            text_content,
            source_url,
            page_title,
            video_start_time,
            video_end_time,
            priority,
            attachments,
        } = body as {
            session_id?: string;
            project_id?: string;
            capture_type?: BrowserCaptureType;
            text_content?: string;
            source_url?: string;
            page_title?: string;
            video_start_time?: number;
            video_end_time?: number;
            priority?: number;
            attachments?: Attachment[];
        };

        // -- Validate required fields -------------------------------------------
        if (!session_id || !project_id || !capture_type) {
            return NextResponse.json(
                { error: "`session_id`, `project_id`, and `capture_type` are required" },
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

        // -- Sync: Insert capture row -------------------------------------------
        const { data: captureRow, error: captureError } = await supabase
            .from("captures")
            .insert({
                session_id,
                project_id,
                capture_type,
                source_url: source_url ?? null,
                page_title: page_title ?? null,
                text_content: text_content ?? null,
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

            const { error: attError } = await supabase
                .from("capture_attachments")
                .insert(attachmentRows);

            if (attError) {
                console.error(`[ingest/browser] Attachment insert failed for capture ${capture_id}:`, attError);
                // Non-fatal: capture was created, just log the error
            }
        }

        // -- Respond immediately -----------------------------------------------
        const response = NextResponse.json({ capture_id }, { status: 200 });

        // -- Async: Embed pipeline (fire-and-forget) ----------------------------
        processBrowserCaptureAsync({
            capture_id,
            capture_type,
            text_content: text_content ?? "",
            source_url: source_url ?? "",
            video_start_time,
            video_end_time,
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
    capture_type: BrowserCaptureType;
    text_content: string;
    source_url: string;
    video_start_time?: number;
    video_end_time?: number;
}): Promise<void> {
    const admin = createAdminClient();
    let fullText = args.text_content;

    // -- Step 1: Fetch YouTube transcript for VIDEO_SEGMENT -------------------
    if (args.capture_type === "VIDEO_SEGMENT" && args.source_url) {
        try {
            // Dynamic import so the module doesn't break builds if optional dep missing
            const { YoutubeTranscript } = await import("youtube-transcript");

            // Extract video ID from URL
            const videoId = extractYoutubeVideoId(args.source_url);
            if (videoId) {
                const transcript = await YoutubeTranscript.fetchTranscript(videoId);
                // Filter to the requested time range if provided
                const relevantSegments = transcript.filter((seg) => {
                    if (
                        args.video_start_time !== undefined &&
                        args.video_end_time !== undefined
                    ) {
                        const segStart = seg.offset / 1000; // offset is in ms
                        const segEnd = segStart + seg.duration / 1000;
                        return segStart >= args.video_start_time && segEnd <= args.video_end_time + 5;
                    }
                    return true;
                });

                const transcriptText = relevantSegments.map((s) => s.text).join(" ");
                fullText = fullText
                    ? `${fullText}\n\n[Transcript]\n${transcriptText}`
                    : transcriptText;
            }
        } catch (transcriptErr) {
            // Graceful fallback — transcripts may be disabled
            console.warn(
                `[ingest/browser] YouTube transcript fetch failed for ${args.source_url}:`,
                transcriptErr
            );
        }
    }

    if (!fullText || fullText.trim().length === 0) {
        console.log(`[ingest/browser] No text content for capture ${args.capture_id}, skipping embed`);
        return;
    }

    // -- Update text_content with the final merged text (may include transcript)
    // This runs after the transcript has been appended so the card shows full content.
    try {
        await admin
            .from("captures")
            .update({ text_content: fullText })
            .eq("id", args.capture_id);
    } catch (updateErr) {
        console.warn(`[ingest/browser] text_content update failed for ${args.capture_id}:`, updateErr);
        // Non-fatal — the initial text_content from the insert is still available
    }

    // -- Step 2: Haiku summary ------------------------------------------------
    let summary = "";
    try {
        const summaryPrompt = `Summarize the following developer/learning content in clear markdown. Be concise but thorough. Include key concepts, facts, and any code-related insights.\n\n---\n\n${fullText.slice(0, 15000)}`;
        summary = await invokeClaudeHaiku(summaryPrompt);

        await admin
            .from("captures")
            .update({ ai_markdown_summary: summary })
            .eq("id", args.capture_id);
    } catch (haikuErr) {
        console.error(`[ingest/browser] Haiku summary failed for ${args.capture_id}:`, haikuErr);
        // Continue — embed raw text even without a summary
    }

    // -- Step 3: Chunk + Embed + Save -----------------------------------------
    const textToEmbed = summary || fullText;
    const chunks = chunkText(textToEmbed);

    if (chunks.length === 0) return;

    const chunkRows: {
        capture_id: string;
        chunk_text: string;
        embedding: number[];
        chunk_index: number;
    }[] = [];

    for (let i = 0; i < chunks.length; i++) {
        try {
            const embedding = await invokeTitanEmbedding(chunks[i]);
            chunkRows.push({
                capture_id: args.capture_id,
                chunk_text: chunks[i],
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
