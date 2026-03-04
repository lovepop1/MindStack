import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// POST /api/workspaces/test
// Minimal test endpoint to isolate the issue
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        // Step 1: Get user
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json(
                { 
                    step: "auth",
                    error: "Unauthorized",
                    details: userError?.message 
                },
                { status: 401 }
            );
        }

        const body = await req.json();
        const { name, display_name } = body as {
            name?: string;
            display_name?: string;
        };

        if (!name || !display_name) {
            return NextResponse.json(
                { step: "validation", error: "name and display_name required" },
                { status: 400 }
            );
        }

        // Step 2: Try to insert workspace
        const join_code = "TEST01";
        
        const { data: workspace, error: workspaceError } = await supabase
            .from("workspaces")
            .insert({
                name: name.trim(),
                join_code,
                created_by: user.id,
            })
            .select("id")
            .single();

        if (workspaceError) {
            return NextResponse.json(
                {
                    step: "workspace_insert",
                    error: workspaceError.message,
                    details: workspaceError.details,
                    hint: workspaceError.hint,
                    code: workspaceError.code,
                },
                { status: 500 }
            );
        }

        if (!workspace) {
            return NextResponse.json(
                { step: "workspace_insert", error: "No workspace returned" },
                { status: 500 }
            );
        }

        // Step 3: Try to insert member
        const { error: memberError } = await supabase
            .from("workspace_members")
            .insert({
                workspace_id: workspace.id,
                user_id: user.id,
                display_name: display_name.trim(),
                role: "ADMIN",
            });

        if (memberError) {
            // Cleanup
            await supabase.from("workspaces").delete().eq("id", workspace.id);
            
            return NextResponse.json(
                {
                    step: "member_insert",
                    error: memberError.message,
                    details: memberError.details,
                    hint: memberError.hint,
                    code: memberError.code,
                },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            workspace_id: workspace.id,
            join_code,
        });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/workspaces/test]", err);
        return NextResponse.json(
            { 
                step: "exception",
                error: "Internal server error",
                details: err instanceof Error ? err.message : String(err)
            },
            { status: 500 }
        );
    }
}
