import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("Missing supabase env vars");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
    const { data: projects, error } = await supabase.from('projects').select('id, user_id').limit(1);
    if (error || !projects || projects.length === 0) {
        console.error("Error fetching projects", error);
        return;
    }
    const projectId = projects[0].id;
    console.log("Found project:", projectId);

    try {
        const res = await fetch(`http://localhost:3000/api/projects/${projectId}/captures`);
        const text = await res.text();
        console.log("API Status:", res.status);
        console.log("API Response:", text.substring(0, 500));
    } catch (e) {
        console.error("API Fetch Error:", e);
    }
}
check();
