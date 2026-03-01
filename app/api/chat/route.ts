import { NextRequest } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";
import {
    invokeTitanEmbedding,
    streamClaudeSonnet,
    ClaudeContentBlock,
    ClaudeMessage,
} from "@/lib/bedrock";
import { fetchImageAsBase64 } from "@/lib/s3";

// ---------------------------------------------------------------------------
// POST /api/chat
// Multimodal RAG Engine with SSE streaming.
//
// Request body: {
//   project_id: string,
//   current_query: string,
//   messages: { role: "user" | "assistant", content: string }[]
// }
//
// SSE event format:
//   data: {"type":"sources","data":[...s3_urls]}\n\n
//   data: {"type":"delta","data":"...text chunk..."}\n\n
//   data: {"type":"done"}\n\n
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    let jwt: string;
    try {
        jwt = extractJwt(req);
    } catch (err) {
        if (err instanceof Response) return err;
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const supabase = createAuthClient(jwt);

    let project_id: string;
    let current_query: string;
    let incomingMessages: { role: "user" | "assistant"; content: string }[];

    try {
        const body = await req.json();
        project_id = body.project_id;
        current_query = body.current_query;
        incomingMessages = body.messages ?? [];

        if (!project_id || !current_query) {
            return new Response(
                JSON.stringify({ error: "`project_id` and `current_query` are required" }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            );
        }
    } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    // Build a streaming SSE ReadableStream
    const stream = new ReadableStream({
        async start(controller) {
            function emit(event: Record<string, unknown>) {
                controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
                );
            }

            try {
                // ----------------------------------------------------------------
                // Step 1: Embed the current query with Titan
                // ----------------------------------------------------------------
                let queryEmbedding: number[];
                try {
                    queryEmbedding = await invokeTitanEmbedding(current_query);
                } catch (embedErr) {
                    console.error("[chat] Query embedding failed:", embedErr);
                    emit({ type: "error", data: "Failed to embed query" });
                    controller.close();
                    return;
                }

                // ----------------------------------------------------------------
                // Step 2: pgvector similarity search — LIMIT 5 to prevent overflow
                // ----------------------------------------------------------------
                const { data: matchedChunks, error: rpcError } = await supabase.rpc(
                    "match_captures",
                    {
                        query_embedding: queryEmbedding,
                        match_project_id: project_id,
                        match_count: 5,
                    }
                );

                if (rpcError) {
                    console.error("[chat] pgvector RPC error:", rpcError);
                    emit({ type: "error", data: "Vector search failed" });
                    controller.close();
                    return;
                }

                const chunks = (matchedChunks as {
                    capture_id: string;
                    chunk_text: string;
                    similarity: number;
                }[]) ?? [];

                // ----------------------------------------------------------------
                // Step 3: Gather parent captures, sessions, and attachments
                // ----------------------------------------------------------------
                const captureIds = [...new Set(chunks.map((c) => c.capture_id))];

                let captures: {
                    id: string;
                    session_id: string;
                    capture_type: string;
                    page_title: string | null;
                    ai_markdown_summary: string | null;
                    ide_code_diff: string | null;
                    ide_error_log: string | null;
                    source_url: string | null;
                    // Supabase returns related rows as arrays even for to-one relations
                    sessions: { active_file_context: string | null }[] | null;
                    capture_attachments: {
                        s3_url: string;
                        file_type: string;
                        file_name: string;
                    }[];
                }[] = [];

                if (captureIds.length > 0) {
                    const { data, error: captureErr } = await supabase
                        .from("captures")
                        .select(
                            `id, session_id, capture_type, page_title, ai_markdown_summary,
               ide_code_diff, ide_error_log, source_url,
               sessions ( active_file_context ),
               capture_attachments ( s3_url, file_type, file_name )`
                        )
                        .in("id", captureIds);

                    if (captureErr) {
                        console.error("[chat] Capture fetch error:", captureErr);
                    } else {
                        captures = (data as unknown as typeof captures) ?? [];
                    }
                }

                // ----------------------------------------------------------------
                // Step 4: Collect S3 URLs and identify images/pdfs for Base64 injection
                // ----------------------------------------------------------------
                const allS3Urls: string[] = [];
                const mediaPayloads: { base64: string; mimeType: string; isPdf: boolean }[] = [];

                for (const capture of captures) {
                    for (const att of capture.capture_attachments) {
                        allS3Urls.push(att.s3_url);

                        if (att.file_type === "IMAGE" || att.file_type === "PDF") {
                            try {
                                const mediaData = await fetchImageAsBase64(att.s3_url);
                                mediaPayloads.push({
                                    ...mediaData,
                                    isPdf: att.file_type === "PDF",
                                });
                            } catch (mediaErr) {
                                console.warn(
                                    `[chat] Media fetch failed for ${att.s3_url}:`,
                                    mediaErr
                                );
                            }
                        }
                    }
                }

                // Emit sources event FIRST so the client can render reference links
                emit({ type: "sources", data: allS3Urls });

                // ----------------------------------------------------------------
                // Step 5: Build the RAG context text block
                // ----------------------------------------------------------------
                const contextParts: string[] = [];

                captures.forEach((capture, idx) => {
                    const captureBlock: string[] = [];
                    captureBlock.push(`[DOCUMENT ${idx + 1}]`);
                    captureBlock.push(`Source Type: ${capture.capture_type}`);

                    if (capture.page_title) {
                        captureBlock.push(`Title: ${capture.page_title}`);
                    }
                    if (capture.source_url) {
                        captureBlock.push(`Source URL: ${capture.source_url}`);
                    }

                    if (capture.ai_markdown_summary) {
                        captureBlock.push(`[Summary]\n${capture.ai_markdown_summary}`);
                    }
                    if (capture.ide_code_diff) {
                        captureBlock.push(`[Code Diff]\n\`\`\`diff\n${capture.ide_code_diff}\n\`\`\``);
                    }
                    if (
                        capture.sessions &&
                        Array.isArray(capture.sessions) &&
                        capture.sessions[0]?.active_file_context
                    ) {
                        captureBlock.push(`[Active File]\n${capture.sessions[0].active_file_context}`);
                    }

                    if (capture.capture_attachments && capture.capture_attachments.length > 0) {
                        const attachmentsList = capture.capture_attachments
                            .map((att) => `- [${att.file_type}] ${att.file_name} (URL: ${att.s3_url})`)
                            .join("\n");
                        captureBlock.push(`[Attachments]\n${attachmentsList}`);
                    }

                    // Find all matched vector chunks for THIS specific capture
                    const relatedChunks = chunks.filter((c) => c.capture_id === capture.id);
                    if (relatedChunks.length > 0) {
                        captureBlock.push(`Content:`);
                        for (const chunk of relatedChunks) {
                            captureBlock.push(`--- Fragment ---\n${chunk.chunk_text}`);
                        }
                    }

                    contextParts.push(captureBlock.join("\n"));
                });

                const contextText = contextParts.slice(0, 15).join("\n\n-------------------\n\n"); // safety cap

                // ----------------------------------------------------------------
                // Step 6: Build Claude multimodal messages
                // ----------------------------------------------------------------
                const systemPrompt = `You are MindStack, an AI assistant with deep knowledge of a developer's learning history.
Answer questions accurately using the provided context. Reference specific captures, diffs, or file names when relevant.

Formatting Rules:

Always use markdown.
When writing code, use fenced code blocks with the correct language (e.g., \`\`\`python).
If a user asks about an image, diagram, or video frame, look in the retrieved context for its URL. You must embed the image directly in your response using markdown syntax: ![Image Description](https://your-s3-bucket-url.com/image.png).`;

                // Reconstruct message history from the request
                const historyMessages: ClaudeMessage[] = incomingMessages.slice(-10).map((m) => ({
                    role: m.role,
                    content: m.content,
                }));

                // Build the final user message with context + images
                const userContent: ClaudeContentBlock[] = [];

                if (contextText) {
                    userContent.push({
                        type: "text",
                        text: `## Retrieved Context\n\n${contextText}\n\n---\n\n## Question\n${current_query}`,
                    });
                } else {
                    // No captures ingested yet — force Claude to return the exact empty state
                    // markdown that the frontend expects.
                    userContent.push({
                        type: "text",
                        text: `No captures have been ingested into MindStack yet for this project. 
                        
You MUST reply with exactly this markdown text, word for word, and NOTHING else:

🧠
### No Progress Data Available
I don't have any captured activity or progress data available for your project yet. To start tracking your development journey, you'll need to:
* Install the MindStack browser extension or IDE plugin
* Begin capturing your coding sessions, web research, and other development activities

Once you start capturing data, I'll be able to provide insights about your progress, summarize what you've learned, and help you navigate your development history.

Would you like information on how to set up MindStack to start tracking your progress?`,
                    });
                }

                // Inject Base64 media (up to 10 to manage token budget but allow for rich context)
                for (const media of mediaPayloads.slice(0, 10)) {
                    if (media.isPdf) {
                        userContent.push({
                            type: "document",
                            source: {
                                type: "base64",
                                media_type: "application/pdf",
                                data: media.base64,
                            },
                        });
                    } else {
                        userContent.push({
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: media.mimeType,
                                data: media.base64,
                            },
                        });
                    }
                }

                const claudeMessages: ClaudeMessage[] = [
                    ...historyMessages,
                    { role: "user", content: userContent },
                ];

                // ----------------------------------------------------------------
                // Step 7: Stream Claude 3.7 Sonnet response as SSE deltas
                // ----------------------------------------------------------------
                for await (const textDelta of streamClaudeSonnet(
                    claudeMessages,
                    systemPrompt
                )) {
                    emit({ type: "delta", data: textDelta });
                }

                emit({ type: "done" });
            } catch (err) {
                console.error("[POST /api/chat] Stream error:", err);
                emit({ type: "error", data: "An unexpected error occurred" });
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no", // disable nginx buffering for SSE
        },
    });
}
