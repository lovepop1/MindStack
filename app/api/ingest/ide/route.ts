import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";
import { invokeClaudeHaiku, invokeTitanEmbedding } from "@/lib/bedrock"; 
import { chunkText } from "@/lib/chunker";

// ---------------------------------------------------------------------------
// Allowed IDE capture types (Expanded for Telemetry)
// ---------------------------------------------------------------------------
type IdeCaptureType = 
    | "IDE_BUG_FIX" 
    | "IDE_PROGRESS_SNAPSHOT"
    | "IDE_SESSION_FINAL_SNAPSHOT"
    | "IDE_DEBUG_EPISODE_START"
    | "IDE_DEBUG_EPISODE_UPDATE"
    | "IDE_DEBUG_EPISODE_RESOLVED";

// ---------------------------------------------------------------------------
// POST /api/ingest/ide
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
            payload // NEW: Extracted for the rich JSON telemetry
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
            payload?: any; 
        };

        if (!session_id || !capture_type) {
            return NextResponse.json({ error: "`session_id` and `capture_type` are required" }, { status: 400 });
        }

        if (!project_id && !workspace_id) {
            return NextResponse.json({ error: "Either `project_id` or `workspace_id` is required" }, { status: 400 });
        }

        const validTypes: IdeCaptureType[] = [
            "IDE_BUG_FIX", "IDE_PROGRESS_SNAPSHOT", "IDE_SESSION_FINAL_SNAPSHOT",
            "IDE_DEBUG_EPISODE_START", "IDE_DEBUG_EPISODE_UPDATE", "IDE_DEBUG_EPISODE_RESOLVED"
        ];
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

        const safePayload = payload || {};

        // ─── NEW ARCHITECTURE: INTELLIGENT DEBUG EPISODES ────────────────────
        // These route directly to the new relational tables and return 200 immediately.
        if (capture_type.startsWith("IDE_DEBUG_EPISODE")) {
            switch (capture_type) {
                case "IDE_DEBUG_EPISODE_START": {
                    const { error } = await supabase.from("debug_episodes").insert({
                        episode_id: safePayload.episode_id,
                        session_id,
                        project_id: project_id ?? null,
                        workspace_id: workspace_id ?? null,
                        status: 'DEBUGGING',
                        initial_command: safePayload.initial_command,
                        initial_error_message: safePayload.initial_error_message,
                        initial_stacktrace: safePayload.initial_stacktrace,
                    });
                    if (error) throw error;

                    // 🚨 DROPS CARD & TRIGGERS AI
                    const { data: captureRow } = await supabase.from("captures").insert({
                        session_id,
                        project_id: project_id ?? null,
                        workspace_id: workspace_id ?? null,
                        author_display_name: author_display_name,
                        capture_type: "IDE_DEBUG_EPISODE_START",
                        text_content: `🚨 Started bug hunt.\nCommand: ${safePayload.initial_command}\nError: ${safePayload.initial_error_message}`,
                        snapshot_metadata: safePayload
                    }).select("id").single();

                    if (captureRow) {
                        processIdeAsync({
                            capture_id: captureRow.id,
                            project_id: project_id ?? null,
                            workspace_id: workspace_id ?? null,
                            author_display_name,
                            capture_type: "IDE_DEBUG_EPISODE_START",
                            ide_error_log: safePayload.initial_error_message ?? "",
                            ide_code_diff: "",
                            repo_tree: "",
                            ide_file_path: "",
                        }).catch(console.error);
                    }

                    return NextResponse.json({ success: true, message: "Episode started" }, { status: 200 });
                }
                case "IDE_DEBUG_EPISODE_UPDATE": {
                    // 1. Update the background engine array
                    const { error } = await supabase.rpc('append_debug_action', {
                        p_episode_id: safePayload.episode_id,
                        p_new_actions: safePayload.actions_log 
                    });
                    if (error) throw error;

                    // 2. 🚨 ADDED: Drop an Orange visual card onto the timeline!
                    await supabase.from("captures").insert({
                        session_id,
                        project_id: project_id ?? null,
                        workspace_id: workspace_id ?? null,
                        author_display_name: author_display_name,
                        capture_type: "IDE_DEBUG_EPISODE_UPDATE",
                        text_content: `🛠️ Actively debugging an issue...`,
                        snapshot_metadata: safePayload // This ensures the frontend gets the latest actions_log array!
                    });

                    return NextResponse.json({ success: true, message: "Episode updated" }, { status: 200 });
                }
                case "IDE_DEBUG_EPISODE_RESOLVED": {
                    if (!safePayload.fingerprint) {
                        return NextResponse.json({ error: "Missing fingerprint" }, { status: 400 });
                    }

                    await supabase.from("debug_episodes").update({
                        status: 'RESOLVED',
                        timestamp_end: new Date().toISOString()
                    }).eq('episode_id', safePayload.episode_id);

                    const { error } = await supabase.from("bug_knowledge_base").upsert({
                        fingerprint: safePayload.fingerprint,
                        resolution_command: safePayload.resolution_command,
                        git_diff_fix: safePayload.git_diff_fix,
                        local_diff_fix: safePayload.local_diff_fix,
                        files_changed: safePayload.files_changed
                    });
                    if (error) throw error;

                    // 🚨 DROPS CARD & TRIGGERS AI
                    const { data: captureRow } = await supabase.from("captures").insert({
                        session_id,
                        project_id: project_id ?? null,
                        workspace_id: workspace_id ?? null,
                        author_display_name: author_display_name,
                        capture_type: "IDE_DEBUG_EPISODE_RESOLVED",
                        text_content: `✅ Bug successfully resolved!\nResolution Command: ${safePayload.resolution_command}`,
                        ide_code_diff: safePayload.git_diff_fix, 
                        snapshot_metadata: safePayload
                    }).select("id").single();

                    if (captureRow) {
                        processIdeAsync({
                            capture_id: captureRow.id,
                            project_id: project_id ?? null,
                            workspace_id: workspace_id ?? null,
                            author_display_name,
                            capture_type: "IDE_DEBUG_EPISODE_RESOLVED",
                            ide_error_log: "",
                            ide_code_diff: safePayload.git_diff_fix ?? "",
                            repo_tree: "",
                            ide_file_path: safePayload.files_changed?.[0] ?? "", 
                        }).catch(console.error);
                    }

                    return NextResponse.json({ success: true, message: "Bug resolved" }, { status: 200 });
                }
            }
        }

        // ─── EXISTING ARCHITECTURE: SNAPSHOTS & CAPTURES ──────────────────────
        // Build a comprehensive preview for the frontend so it's not empty while Haiku thinks
        const textParts: string[] = [];
        if (ide_file_path) textParts.push(`**File:** \`${ide_file_path}\``);
        if (ide_error_log) textParts.push(`**Error Log:**\n\`\`\`text\n${ide_error_log}\n\`\`\``);
        if (ide_code_diff) textParts.push(`**Code Changes:**\n\`\`\`diff\n${ide_code_diff}\n\`\`\``);
        if (repo_tree) textParts.push(`**Repository State:**\n\`\`\`text\n${repo_tree}\n\`\`\``);
        
        const initialTextContent = textParts.join("\n\n") || "*IDE snapshot captured with no distinct file changes.*";

        // Insert into the existing captures table, but now utilizing the JSONB column
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
                ai_markdown_summary: null, 
                ide_error_log: ide_error_log ?? null,
                ide_code_diff: ide_code_diff ?? null,
                ide_file_path: ide_file_path ?? null,
                priority: priority ?? 0,
                // Inject the massive rich telemetry payload seamlessly
                snapshot_metadata: {
                    files_changed: safePayload.files_changed,
                    files_added: safePayload.files_added,
                    files_deleted: safePayload.files_deleted,
                    lines_added: safePayload.lines_added,
                    lines_removed: safePayload.lines_removed,
                    modules_changed: safePayload.modules_changed,
                    languages_detected: safePayload.languages_detected,
                    open_files: safePayload.open_files,
                    active_file: safePayload.active_file,
                    session_duration: safePayload.session_duration,
                    debug_episodes_count: safePayload.debug_episodes_count,
                    resolved_bugs: safePayload.resolved_bugs,
                    abandoned_bugs: safePayload.abandoned_bugs
                }
            })
            .select("id")
            .single();

        if (captureError || !captureRow) return NextResponse.json({ error: captureError?.message ?? "Insert failed" }, { status: 500 });

        const capture_id = captureRow.id;
        const response = NextResponse.json({ capture_id }, { status: 200 });

        // Trigger the Haiku & Titan embedding pipeline asynchronously
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

    // -- Step 1: Haiku 4.5 translates raw code/error → plain English explanation --
    let plainEnglishExplanation = "";
    try {
        const translationPrompt = `You are a Staff Engineer AI building an automated dev log.
    Analyze the following raw IDE output (error logs, code diffs, or snapshot telemetry) and synthesize it.

    CRITICAL RULES:
    1. ABSOLUTELY NO APOLOGIES OR FILLER. Never say "I don't have enough information," "I cannot see," or "There is no diff."
    2. BE RUTHLESSLY CONCISE. Maximum 3 sentences total.
    3. If data is sparse or empty, output exactly this generic baseline: "Routine IDE state capture."

    Adapt your focus based on the data provided:
    - IF BUG FIX/CRASH: State the error root cause and how the diff fixed it.
    - IF NEW FEATURE: State what functionality was built based on the diff.
    - IF PROGRESS SNAPSHOT: State which files were modified.

    Output EXACTLY these two sections formatted in Markdown:
    1. **Execution**: 1-2 sentence maximum explanation of the actions taken.
    2. **Key Takeaway**: 1 sentence maximum summarizing the core library, concept, or pattern used (for search indexing).

    ---
    RAW IDE TELEMETRY:
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

    // -- Step 3: Embed (Titan v2) + Save ---------------------------------------
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