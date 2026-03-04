import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// POST /api/workspaces/create
// Body: { name: string, display_name: string }
// Creates a new team workspace with a unique join code.
// The creator is automatically added as an ADMIN member.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        // Resolve the user_id from the JWT
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { name, display_name } = body as {
            name?: string;
            display_name?: string;
        };

        if (!name || name.trim().length === 0) {
            return NextResponse.json({ error: "`name` is required" }, { status: 400 });
        }

        if (!display_name || display_name.trim().length === 0) {
            return NextResponse.json(
                { error: "`display_name` is required" },
                { status: 400 }
            );
        }

        // Generate a unique 6-character alphanumeric join code
        const join_code = generateJoinCode();

        // Insert the workspace
        const { data: workspace, error: workspaceError } = await supabase
            .from("workspaces")
            .insert({
                name: name.trim(),
                join_code,
                created_by: user.id,
            })
            .select("id")
            .single();

        if (workspaceError || !workspace) {
            console.error("[POST /api/workspaces/create] Workspace insert error:", workspaceError);
            return NextResponse.json(
                { 
                    error: workspaceError?.message ?? "Failed to create workspace",
                    details: workspaceError?.details,
                    hint: workspaceError?.hint,
                    code: workspaceError?.code
                },
                { status: 500 }
            );
        }

        // Add the creator as an ADMIN member
        const { error: memberError } = await supabase
            .from("workspace_members")
            .insert({
                workspace_id: workspace.id,
                user_id: user.id,
                display_name: display_name.trim(),
                role: "ADMIN",
            });

        if (memberError) {
            console.error("[POST /api/workspaces/create] Member insert error:", memberError);
            // Rollback: delete the workspace if member insertion fails
            await supabase.from("workspaces").delete().eq("id", workspace.id);
            return NextResponse.json(
                { 
                    error: "Failed to add creator as member",
                    details: memberError?.details,
                    hint: memberError?.hint,
                    code: memberError?.code
                },
                { status: 500 }
            );
        }

        return NextResponse.json(
            { workspace_id: workspace.id, join_code },
            { status: 201 }
        );
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/workspaces/create]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// ---------------------------------------------------------------------------
// Generate a random 6-character alphanumeric join code
// ---------------------------------------------------------------------------
function generateJoinCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}
