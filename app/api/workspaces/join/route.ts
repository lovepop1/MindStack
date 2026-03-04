import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// POST /api/workspaces/join
// Body: { join_code: string, display_name: string }
// Allows a user to join an existing workspace via its join code.
// The user is added as a MEMBER.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);
        const adminSupabase = createAdminClient(); // <-- Added Admin Client

        // Resolve the user_id from the JWT
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { join_code, display_name } = body as {
            join_code?: string;
            display_name?: string;
        };

        if (!join_code || join_code.trim().length === 0) {
            return NextResponse.json({ error: "`join_code` is required" }, { status: 400 });
        }

        if (!display_name || display_name.trim().length === 0) {
            return NextResponse.json(
                { error: "`display_name` is required" },
                { status: 400 }
            );
        }

        // FIX 1: Look up the workspace by join code using the ADMIN client to bypass RLS.
        // Using .maybeSingle() prevents the PGRST116 crash if the code is invalid.
        const { data: workspace, error: workspaceError } = await adminSupabase
            .from("workspaces")
            .select("id")
            .eq("join_code", join_code.trim().toUpperCase())
            .maybeSingle();

        if (workspaceError || !workspace) {
            console.error("[POST /api/workspaces/join] Workspace lookup error:", workspaceError);
            return NextResponse.json(
                { error: "Invalid join code. Please check and try again." },
                { status: 404 }
            );
        }

        // FIX 2: Check if user is already a member using .maybeSingle() instead of .single()
        // If they are not a member, this safely returns null instead of crashing.
        const { data: existingMember } = await supabase
            .from("workspace_members")
            .select("workspace_id")
            .eq("workspace_id", workspace.id)
            .eq("user_id", user.id)
            .maybeSingle();

        if (existingMember) {
            return NextResponse.json(
                { error: "You are already a member of this workspace" },
                { status: 409 }
            );
        }

        // Add the user as a MEMBER using the regular auth client
        const { error: memberError } = await supabase
            .from("workspace_members")
            .insert({
                workspace_id: workspace.id,
                user_id: user.id,
                display_name: display_name.trim(),
                role: "MEMBER",
            });

        if (memberError) {
            console.error("[POST /api/workspaces/join] Member insert error:", memberError);
            return NextResponse.json(
                { 
                    error: memberError.message,
                    details: memberError?.details,
                    hint: memberError?.hint,
                    code: memberError?.code
                },
                { status: 500 }
            );
        }

        return NextResponse.json({ workspace_id: workspace.id }, { status: 200 });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/workspaces/join]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}