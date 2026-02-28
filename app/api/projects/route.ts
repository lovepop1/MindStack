import { NextRequest, NextResponse } from "next/server";
import { createAuthClient, createAdminClient, extractJwt } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// GET /api/projects
// Returns all projects belonging to the authenticated user.
// RLS on the `projects` table enforces user_id filtering automatically.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        const { data, error } = await supabase
            .from("projects")
            .select("id, name, description, created_at")
            .order("created_at", { ascending: false });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ projects: data });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[GET /api/projects]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// ---------------------------------------------------------------------------
// POST /api/projects
// Body: { name: string, description?: string }
// Creates a new project and returns its ID.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
    try {
        const jwt = extractJwt(req);
        const supabase = createAuthClient(jwt);

        // Resolve the user_id from the JWT so we can store it explicitly
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser(jwt);

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { name, description } = body as { name?: string; description?: string };

        if (!name || name.trim().length === 0) {
            return NextResponse.json({ error: "`name` is required" }, { status: 400 });
        }

        const { data, error } = await supabase
            .from("projects")
            .insert({ name: name.trim(), description: description?.trim() ?? null, user_id: user.id })
            .select("id")
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ project_id: data.id }, { status: 201 });
    } catch (err) {
        if (err instanceof Response) return err;
        console.error("[POST /api/projects]", err);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
