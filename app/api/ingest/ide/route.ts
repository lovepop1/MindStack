import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { invokeClaudeHaiku, invokeTitanEmbedding } from "@/lib/bedrock"; // ✅ Haiku is back!
import { chunkText } from "@/lib/chunker";

// ---------------------------------------------------------------------------
// Allowed IDE capture types
// ---------------------------------------------------------------------------
type IdeCaptureType = "IDE_BUG_FIX" | "IDE_PROGRESS_SNAPSHOT";

// ---------------------------------------------------------------------------
// POST /api/ingest/ide
// Sync: Insert beautifully formatted capture, return 200.
// Async: Haiku translates the code. BOTH raw code and translation are embedded.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

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
            ide_error_log,
            ide_code_diff,
            repo_tree,
            ide_file_path,
            priority,
        } = body as {
            session_id?: string;
            project_id?: string;
            workspace_id?: string;
            capture_type?: IdeCaptureType;
            ide_error_log?: string;
            ide_code_diff?: string;
            repo_tree?: string;
            ide_file_path?: string;
            priority?: number;
        };

        if (!session_id || !capture_type) {
            return NextResponse.json({ error: "`session_id` and `capture_type` are required" }, { status: 400 });
        }

        if (!project_id && !workspace_id) {
            return NextResponse.json({ error: "Either `project_id` or `workspace_id` is required" }, { status: 400 });
        }

        const validTypes: IdeCaptureType[] = ["IDE_BUG_FIX", "IDE_PROGRESS_SNAPSHOT"];
        if (!validTypes.includes(capture_type)) {
            return NextResponse.json({ error: `Invalid capture_type: ${capture_type}` }, { status: 400 });
        }

        let author_display_name: string | null = null;
        if (workspace_id) {
            const { data: member, error: memberError } = await supabase
                .from("workspace_members")
                .select("display_name")
                .eq("workspace_id", workspace_id)
                .eq("user_id", user.id)
                .single();

            if (memberError || !member) return NextResponse.json({ error: "User is not a member of this workspace" }, { status: 403 });
            author_display_name = member.display_name;
        }

        // Build a comprehensive preview for the frontend so it's not empty while Haiku thinks
        const textParts: string[] = [];
        if (ide_file_path) textParts.push(`**File:** \`${ide_file_path}\``);
        if (ide_error_log) textParts.push(`**Error Log:**\n\`\`\`text\n${ide_error_log}\n\`\`\``);
        if (ide_code_diff) textParts.push(`**Code Changes:**\n\`\`\`diff\n${ide_code_diff}\n\`\`\``);
        if (repo_tree) textParts.push(`**Repository State:**\n\`\`\`text\n${repo_tree}\n\`\`\``);
        
        const initialTextContent = textParts.join("\n\n") || "*IDE snapshot captured with no distinct file changes.*";

        const { data: captureRow, error: captureError } = await supabase
            .from("captures")
            .insert({
                session_id,
                project_id: project_id ?? null,
                workspace_id: workspace_id ?? null,
                author_id: workspace_id ? user.id : null,
                author_display_name: author_display_name,
                capture_type,
                text_content: initialTextContent, 
                ai_markdown_summary: null, // Haiku will update this asynchronously
                ide_error_log: ide_error_log ?? null,
                ide_code_diff: ide_code_diff ?? null,
                ide_file_path: ide_file_path ?? null,
                priority: priority ?? 0,
            })
            .select("id")
            .single();

        if (captureError || !captureRow) return NextResponse.json({ error: captureError?.message ?? "Insert failed" }, { status: 500 });

        const capture_id = captureRow.id;
        const response = NextResponse.json({ capture_id }, { status: 200 });

        processIdeAsync({
            capture_id,
            project_id: project_id ?? null,
            workspace_id: workspace_id ?? null,
            author_display_name,
            capture_type,
            ide_error_log: ide_error_log ?? "",
            ide_code_diff: ide_code_diff ?? "",
            repo_tree: repo_tree ?? "",
            ide_file_path: ide_file_path ?? "",
        }).catch((err) => console.error(`[ingest/ide] Async pipeline failed for ${capture_id}:`, err));

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
    project_id: string | null;
    workspace_id: string | null;
    author_display_name: string | null;
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
    ].filter(Boolean).join("\n\n");

    if (!rawContent.trim()) return;

    // -- Step 1: Haiku translates raw code/error → plain English explanation --
    let plainEnglishExplanation = "";
    try {
        const translationPrompt = `You are a senior developer assistant. Below is raw IDE output from a developer's coding session.
Convert this into two things, formatted in Markdown:
1. **Plain-English Explanation**: What problem occurred and how it was (or is being) resolved.
2. **Key Learning**: The underlying technical concept or pattern involved.
Be concise but precise. Use code blocks for any code references.

---
${rawContent.slice(0, 15000)}`;

        plainEnglishExplanation = await invokeClaudeHaiku(translationPrompt);

        // Update the database so the frontend UI can show the Haiku summary
        await admin
            .from("captures")
            .update({ ai_markdown_summary: plainEnglishExplanation })
            .eq("id", args.capture_id);
    } catch (haikuErr) {
        console.error(`[ingest/ide] Haiku translation failed for ${args.capture_id}:`, haikuErr);
    }

    // -- Step 2: Chunk BOTH raw code AND English translation ------------------
    const rawChunks = chunkText(rawContent, { fileName: args.ide_file_path || undefined });
    const englishChunks = plainEnglishExplanation ? chunkText(plainEnglishExplanation) : [];

    // Combine both sets, labeling them for retrieval context
    const allTextChunks = [
        ...rawChunks.map((c) => `[RAW CODE]\n${c}`),
        ...englishChunks.map((c) => `[EXPLANATION]\n${c}`),
    ];

    if (allTextChunks.length === 0) return;

    const chunkRows: {
        capture_id: string;
        project_id: string | null;
        workspace_id: string | null;
        chunk_text: string;
        embedding: number[];
        chunk_index: number;
    }[] = [];

    // -- Step 3: Embed + Save ------------------------------------------------
    for (let i = 0; i < allTextChunks.length; i++) {
        try {
            let metadataHeader = `[Context: The developer captured a ${args.capture_type.replace(/_/g, " ")}]`;
            if (args.ide_file_path) metadataHeader += `\n[File Path: ${args.ide_file_path}]`;
            if (args.workspace_id && args.author_display_name) {
                metadataHeader += `\n[Contributed by Team Member: ${args.author_display_name}]`;
            }

            const chunkTextData = `${metadataHeader}\n\n${allTextChunks[i]}`;
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
            console.error(`[ingest/ide] Embedding failed for chunk ${i}:`, embedErr);
        }
    }

    if (chunkRows.length > 0) {
        await admin.from("capture_chunks").insert(chunkRows);
    }
}