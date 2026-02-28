import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Auth-bound client — runs under the caller's RLS context.
// Pass the raw JWT extracted from the Authorization header.
// ---------------------------------------------------------------------------
export function createAuthClient(jwt: string) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

    return createSupabaseClient(url, anon, {
        global: {
            headers: {
                Authorization: `Bearer ${jwt}`,
            },
        },
        auth: {
            // Disable auto-refresh; we manage the JWT ourselves from the header
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}

// ---------------------------------------------------------------------------
// Admin client — uses the Service Role key, BYPASSES RLS.
// ONLY use in background async tasks where there is no user request context.
// ---------------------------------------------------------------------------
export function createAdminClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    return createSupabaseClient(url, serviceKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}

// ---------------------------------------------------------------------------
// Helper — extract the Bearer token from a Request's Authorization header.
// Throws a Response (401) so route handlers can simply `await extractJwt(req)`.
// ---------------------------------------------------------------------------
export function extractJwt(req: Request): string {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new Response(
            JSON.stringify({ error: "Missing or invalid Authorization header" }),
            { status: 401, headers: { "Content-Type": "application/json" } }
        );
    }
    return authHeader.slice(7);
}
