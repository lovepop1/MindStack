import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { invokeClaudeHaiku, invokeTitanEmbedding } from "@/lib/bedrock";
import { chunkText } from "@/lib/chunker";

// ---------------------------------------------------------------------------
// Allowed IDE capture types
// ---------------------------------------------------------------------------
type IdeCaptureType = "IDE_BUG_FIX" | "IDE_PROGRESS_SNAPSHOT";

// ---------------------------------------------------------------------------
// POST /api/ingest/ide
// Body: { session_id, project_id, capture_type, ide_error_log?, ide_code_diff?,
//         repo_tree?, ide_file_path? }
// Sync: Insert capture, return 200.
// Async: Haiku translates the bug/diff into plain English.
//        BOTH raw code and English translation are chunked + embedded.
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
            ide_error_log,
            ide_code_diff,
            repo_tree,
            ide_file_path,
            priority,
        } = body as {
            session_id?: string;
            project_id?: string;
            capture_type?: IdeCaptureType;
            ide_error_log?: string;
            ide_code_diff?: string;
            repo_tree?: string;
            ide_file_path?: string;
            priority?: number;
        };

        // -- Validate ------------------------------------------------------------
        if (!session_id || !project_id || !capture_type) {
            return NextResponse.json(
                { error: "`session_id`, `project_id`, and `capture_type` are required" },
                { status: 400 }
            );
        }

        const validTypes: IdeCaptureType[] = ["IDE_BUG_FIX", "IDE_PROGRESS_SNAPSHOT"];
        if (!validTypes.includes(capture_type)) {
            return NextResponse.json({ error: `Invalid capture_type: ${capture_type}` }, { status: 400 });
        }

        // -- Sync: Insert capture ------------------------------------------------
        // Build a text_content preview from available IDE fields so the card is
        // immediately populated — the async pipeline will later add ai_markdown_summary.
        const textParts: string[] = [];
        if (ide_error_log) textParts.push(`## Error Log\n${ide_error_log}`);
        if (ide_code_diff) textParts.push(`## Code Diff\n${ide_code_diff}`);
        const initialTextContent = textParts.join("\n\n") || null;

        const { data: captureRow, error: captureError } = await supabase
            .from("captures")
            .insert({
                session_id,
                project_id,
                capture_type,
                text_content: initialTextContent,
                ide_error_log: ide_error_log ?? null,
                ide_code_diff: ide_code_diff ?? null,
                ide_file_path: ide_file_path ?? null,
                priority: priority ?? 0,
            })
            .select("id")
            .single();

        if (captureError || !captureRow) {
            return NextResponse.json({ error: captureError?.message ?? "Insert failed" }, { status: 500 });
        }

        const capture_id = captureRow.id;

        // -- Respond immediately -------------------------------------------------
        const response = NextResponse.json({ capture_id }, { status: 200 });

        // -- Async: Pipeline -----------------------------------------------------
        processIdeAsync({
            capture_id,
            capture_type,
            ide_error_log: ide_error_log ?? "",
            ide_code_diff: ide_code_diff ?? "",
            repo_tree: repo_tree ?? "",
            ide_file_path: ide_file_path ?? "",
        }).catch((err) =>
            console.error(`[ingest/ide] Async pipeline failed for ${capture_id}:`, err)
        );

        return response;
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/ingest/ide]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// ---------------------------------------------------------------------------
// Async pipeline
// ---------------------------------------------------------------------------
async function processIdeAsync(args: {
    capture_id: string;
    capture_type: IdeCaptureType;
    ide_error_log: string;
    ide_code_diff: string;
    repo_tree: string;
    ide_file_path: string;
}): Promise<void> {
    const admin = createAdminClient();

    const rawContent = [
        args.ide_error_log && `## Error Log\n${args.ide_error_log}`,
        args.ide_code_diff && `## Code Diff\n${args.ide_code_diff}`,
        args.repo_tree && `## Repo Structure\n${args.repo_tree}`,
    ]
        .filter(Boolean)
        .join("\n\n");

    if (!rawContent.trim()) {
        console.log(`[ingest/ide] No content to process for capture ${args.capture_id}`);
        return;
    }

    // -- Step 1: Haiku translates raw code/error → plain English explanation --
    let plainEnglishExplanation = "";
    let summary = "";
    try {
        const translationPrompt = `You are a senior developer assistant. Below is raw IDE output from a developer's coding session.

Convert this into two things, formatted in Markdown:
1. **Plain-English Explanation**: What problem occurred and how it was (or is being) resolved.
2. **Key Learning**: The underlying technical concept or pattern involved.

Be concise but precise. Use code blocks for any code references.

---

${rawContent.slice(0, 15000)}`;

        plainEnglishExplanation = await invokeClaudeHaiku(translationPrompt);
        summary = plainEnglishExplanation;

        await admin
            .from("captures")
            .update({ ai_markdown_summary: summary })
            .eq("id", args.capture_id);
    } catch (haikuErr) {
        console.error(`[ingest/ide] Haiku translation failed for ${args.capture_id}:`, haikuErr);
    }

    // -- Step 2: Chunk BOTH raw code AND English translation ------------------
    // Skip IDE auto-generated files in the repo tree
    const rawChunks = chunkText(rawContent, {
        fileName: args.ide_file_path || undefined,
    });

    const englishChunks = plainEnglishExplanation
        ? chunkText(plainEnglishExplanation)
        : [];

    // Combine both sets, labeling them for retrieval context
    const allTextChunks = [
        ...rawChunks.map((c) => `[RAW]\n${c}`),
        ...englishChunks.map((c) => `[EXPLANATION]\n${c}`),
    ];

    if (allTextChunks.length === 0) return;

    const chunkRows: {
        capture_id: string;
        chunk_text: string;
        embedding: number[];
        chunk_index: number;
    }[] = [];

    for (let i = 0; i < allTextChunks.length; i++) {
        try {
            const embedding = await invokeTitanEmbedding(allTextChunks[i]);
            chunkRows.push({
                capture_id: args.capture_id,
                chunk_text: allTextChunks[i],
                embedding,
                chunk_index: i,
            });
        } catch (embedErr) {
            console.error(
                `[ingest/ide] Embedding failed for chunk ${i} of ${args.capture_id}:`,
                embedErr
            );
        }
    }

    if (chunkRows.length > 0) {
        const { error } = await admin.from("capture_chunks").insert(chunkRows);
        if (error) {
            console.error(`[ingest/ide] Chunk insert failed for ${args.capture_id}:`, error);
        } else {
            console.log(
                `[ingest/ide] Saved ${chunkRows.length} chunks (raw+explanation) for ${args.capture_id}`
            );
        }
    }
}
