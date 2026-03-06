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
            payload 
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

        // ─── MASTER ROUTER: HANDLES ALL 6 TELEMETRY TYPES CLEANLY ────────────────────
        switch (capture_type) {
            
            // 1. BUG HUNT STARTED
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

                const { data: captureRow } = await supabase.from("captures").insert({
                    session_id, project_id: project_id ?? null, workspace_id: workspace_id ?? null,
                    author_display_name: author_display_name, capture_type: "IDE_DEBUG_EPISODE_START",
                    text_content: `🚨 Started bug hunt.\nCommand: ${safePayload.initial_command}\nError: ${safePayload.initial_error_message}`,
                    snapshot_metadata: safePayload
                }).select("id").single();

                if (captureRow) {
                    processIdeAsync({
                        capture_id: captureRow.id, project_id: project_id ?? null, workspace_id: workspace_id ?? null, author_display_name, capture_type,
                        ide_error_log: safePayload.initial_error_message ?? "", ide_code_diff: "", repo_tree: "", ide_file_path: "",
                        payload: safePayload // 🚨 Passed to RAG
                    }).catch(console.error);
                }
                return NextResponse.json({ success: true, message: "Episode started" }, { status: 200 });
            }

            // 2. BUG HUNT UPDATED (DEVELOPER TYPING COMMANDS / SAVING FILES)
            case "IDE_DEBUG_EPISODE_UPDATE": {
                const { error } = await supabase.rpc('append_debug_action', {
                    p_episode_id: safePayload.episode_id,
                    p_new_actions: safePayload.actions_log 
                });
                if (error) throw error;

                await supabase.from("captures").insert({
                    session_id, project_id: project_id ?? null, workspace_id: workspace_id ?? null,
                    author_display_name: author_display_name, capture_type: "IDE_DEBUG_EPISODE_UPDATE",
                    text_content: `🛠️ Actively debugging an issue...`,
                    snapshot_metadata: safePayload 
                });
                return NextResponse.json({ success: true, message: "Episode updated" }, { status: 200 });
            }

            // 3. BUG HUNT RESOLVED
            case "IDE_DEBUG_EPISODE_RESOLVED": {
                if (!safePayload.fingerprint) return NextResponse.json({ error: "Missing fingerprint" }, { status: 400 });

                await supabase.from("debug_episodes").update({ status: 'RESOLVED', timestamp_end: new Date().toISOString() }).eq('episode_id', safePayload.episode_id);

                const { error } = await supabase.from("bug_knowledge_base").upsert({
                    fingerprint: safePayload.fingerprint, resolution_command: safePayload.resolution_command,
                    git_diff_fix: safePayload.git_diff_fix, local_diff_fix: safePayload.local_diff_fix, files_changed: safePayload.files_changed
                });
                if (error) throw error;

                const { data: captureRow } = await supabase.from("captures").insert({
                    session_id, project_id: project_id ?? null, workspace_id: workspace_id ?? null,
                    author_display_name: author_display_name, capture_type: "IDE_DEBUG_EPISODE_RESOLVED",
                    text_content: `✅ Bug successfully resolved!\nResolution Command: ${safePayload.resolution_command}`,
                    ide_code_diff: safePayload.local_diff_fix || safePayload.git_diff_fix, 
                    snapshot_metadata: safePayload
                }).select("id").single();

                if (captureRow) {
                    processIdeAsync({
                        capture_id: captureRow.id, project_id: project_id ?? null, workspace_id: workspace_id ?? null, author_display_name, capture_type,
                        ide_error_log: "", ide_code_diff: safePayload.local_diff_fix || safePayload.git_diff_fix || "", repo_tree: "", ide_file_path: safePayload.files_changed?.[0] ?? "", 
                        payload: safePayload // 🚨 Passed to RAG
                    }).catch(console.error);
                }
                return NextResponse.json({ success: true, message: "Bug resolved" }, { status: 200 });
            }

            // 4. ALL STANDARD SNAPSHOTS (INTERVAL & FINAL)
            case "IDE_PROGRESS_SNAPSHOT":
            case "IDE_SESSION_FINAL_SNAPSHOT":
            case "IDE_BUG_FIX": {
                const finalCodeDiff = safePayload.git_diff_since_commit || ide_code_diff || null;
                const finalRepoTree = safePayload.repo_tree || repo_tree || null;
                const finalFilePath = safePayload.active_file || ide_file_path || null;

                const textParts: string[] = [];
                if (finalFilePath) textParts.push(`**Active File:** \`${finalFilePath}\``);
                if (ide_error_log) textParts.push(`**Error Log:**\n\`\`\`text\n${ide_error_log}\n\`\`\``);
                if (finalCodeDiff) textParts.push(`**Code Changes:**\n\`\`\`diff\n${finalCodeDiff}\n\`\`\``);
                if (finalRepoTree) textParts.push(`**Repository State:**\n\`\`\`text\n${finalRepoTree}\n\`\`\``);
                
                let defaultMsg = capture_type === "IDE_SESSION_FINAL_SNAPSHOT" ? "🏁 Session summary captured." : "📸 Progress snapshot logged.";
                const initialTextContent = textParts.join("\n\n") || `*${defaultMsg}*`;

                const { data: captureRow, error: captureError } = await supabase.from("captures").insert({
                    session_id,
                    project_id: project_id ?? null,
                    workspace_id: workspace_id ?? null,
                    author_id: workspace_id ? user.id : null,
                    author_display_name: author_display_name,
                    capture_type,
                    text_content: initialTextContent, 
                    ai_markdown_summary: null, 
                    ide_error_log: ide_error_log ?? null,
                    ide_code_diff: finalCodeDiff,
                    ide_file_path: finalFilePath,
                    priority: priority ?? 0,
                    snapshot_metadata: safePayload
                }).select("id").single();

                if (captureError || !captureRow) return NextResponse.json({ error: captureError?.message ?? "Insert failed" }, { status: 500 });

                processIdeAsync({
                    capture_id: captureRow.id,
                    project_id: project_id ?? null,
                    workspace_id: workspace_id ?? null,
                    author_display_name,
                    capture_type,
                    ide_error_log: ide_error_log ?? "",
                    ide_code_diff: finalCodeDiff ?? "",
                    repo_tree: finalRepoTree ?? "",
                    ide_file_path: finalFilePath ?? "",
                    payload: safePayload // 🚨 Passed to RAG
                }).catch((err) => console.error(`[ingest/ide] Async failed:`, err));

                return NextResponse.json({ capture_id: captureRow.id }, { status: 200 });
            }
        }
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
    payload?: any; // 🚨 Added to signature
}): Promise<void> {
    const admin = createAdminClient();

    // 🚨 MASSIVE UPGRADE: Unpack the JSON Payload for the RAG Model 🚨
    const textParts: string[] = [];
    
    if (args.ide_file_path) textParts.push(`## Active File\n${args.ide_file_path}`);
    if (args.ide_error_log || args.payload?.initial_error_message) textParts.push(`## Error Log\n${args.ide_error_log || args.payload?.initial_error_message}`);
    if (args.payload?.initial_stacktrace) textParts.push(`## Stacktrace\n${args.payload.initial_stacktrace}`);
    if (args.payload?.initial_command) textParts.push(`## Initial Command\n${args.payload.initial_command}`);
    if (args.payload?.resolution_command) textParts.push(`## Resolution Command\n${args.payload.resolution_command}`);
    
    if (args.payload?.actions_log && Array.isArray(args.payload.actions_log)) {
        const logStr = args.payload.actions_log.map((a: any) => `[${a.time || a.timestamp}] ${a.type === 'command' ? '$ ' + a.cmd : 'Saved ' + a.file}`).join('\n');
        if (logStr) textParts.push(`## Debugging Timeline\n${logStr}`);
    }

    const diff = args.payload?.local_diff_fix || args.payload?.git_diff_fix || args.payload?.git_diff_since_commit || args.ide_code_diff;
    if (diff) textParts.push(`## Code Diff\n${diff}`);
    
    if (args.payload?.files_changed) {
        const fc = args.payload.files_changed;
        if (Array.isArray(fc)) textParts.push(`## Files Changed\n${fc.join(', ')}`);
        else textParts.push(`## Files Changed Count\n${fc}`);
    }
    
    if (args.payload?.modules_changed && Array.isArray(args.payload.modules_changed)) textParts.push(`## Modules Changed\n${args.payload.modules_changed.join(', ')}`);
    if (args.payload?.languages_detected && Array.isArray(args.payload.languages_detected)) textParts.push(`## Languages Used\n${args.payload.languages_detected.join(', ')}`);
    
    if (args.payload?.session_duration !== undefined) {
        textParts.push(`## Session Metrics\nDuration: ${args.payload.session_duration}s\nBugs Encountered: ${args.payload.debug_episodes_count || 0}\nBugs Resolved: ${args.payload.resolved_bugs || 0}\nBugs Abandoned: ${args.payload.abandoned_bugs || 0}`);
    }
    
    if (args.repo_tree) textParts.push(`## Repo Structure\n${args.repo_tree}`);

    const rawContent = textParts.join("\n\n");

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