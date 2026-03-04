# Team Workspaces Troubleshooting Guide

## Current Issues & Solutions

### Issue 1: RLS Policy Violation (Error 42501)
**Error Message:**
```
new row violates row-level security policy for table "workspaces"
```

**Root Cause:** Tables exist but lack RLS policies for INSERT operations.

**Solution:** Apply RLS policies (see Step 1 below).

---

### Issue 2: Infinite Recursion (Error 42P17)
**Error Message:**
```
infinite recursion detected in policy for relation "workspace_members"
```

**Root Cause:** The SELECT policy on `workspace_members` references itself in a subquery, creating a circular dependency.

**Bad Policy (Causes Recursion):**
```sql
CREATE POLICY "Users can read workspace members"
ON workspace_members FOR SELECT
USING (
    workspace_id IN (
        SELECT workspace_id FROM workspace_members  -- ← Triggers same policy!
        WHERE user_id = auth.uid()
    )
);
```

**Good Policy (Non-Recursive):**
```sql
CREATE POLICY "Users can read their own memberships"
ON workspace_members FOR SELECT
USING (user_id = auth.uid());  -- ← Direct comparison, no subquery
```

**Solution:** Use the fixed policies from `supabase_rls_policies.sql` which avoid recursion.

---

## ✅ Solution: Apply Non-Recursive RLS Policies

### Step 0: Clean Up Existing Policies (If Any)
If you already ran the old policies, drop them first:

```sql
DROP POLICY IF EXISTS "Users can create workspaces" ON workspaces;
DROP POLICY IF EXISTS "Users can read their workspaces" ON workspaces;
DROP POLICY IF EXISTS "Users can join workspaces" ON workspace_members;
DROP POLICY IF EXISTS "Users can read workspace members" ON workspace_members;
DROP POLICY IF EXISTS "Users can read their own memberships" ON workspace_members;
```

### Step 1: Open Supabase SQL Editor
1. Go to your Supabase Dashboard
2. Navigate to **SQL Editor** in the left sidebar
3. Click **New Query**

### Step 2: Run the Non-Recursive RLS Policies Script
Copy and paste the contents of `supabase_rls_policies.sql` into the SQL editor and execute it.

**Or run this minimal non-recursive version:**

```sql
-- Enable RLS
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- WORKSPACE_MEMBERS POLICIES (MUST COME FIRST!)
-- ============================================================================

-- Allow users to insert themselves as members
CREATE POLICY "Users can join workspaces"
ON workspace_members FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

-- Allow users to read their own membership records
-- CRITICAL: Non-recursive - only checks current row
CREATE POLICY "Users can read their own memberships"
ON workspace_members FOR SELECT TO authenticated
USING (user_id = auth.uid());

-- ============================================================================
-- WORKSPACES POLICIES (AFTER workspace_members policies)
-- ============================================================================

-- Allow users to create workspaces
CREATE POLICY "Users can create workspaces"
ON workspaces FOR INSERT TO authenticated
WITH CHECK (created_by = auth.uid());

-- Allow users to read workspaces they're members of
-- Now safe because workspace_members policy is non-recursive
CREATE POLICY "Users can read their workspaces"
ON workspaces FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = workspaces.id
        AND wm.user_id = auth.uid()
    )
);
```

### Step 3: Verify Policies Were Created
Run this query to check:

```sql
SELECT tablename, policyname, cmd 
FROM pg_policies 
WHERE tablename IN ('workspaces', 'workspace_members');
```

You should see at least 4 policies (2 for each table).

### Step 4: Test the Endpoint Again
```bash
POST /api/workspaces/create
Authorization: Bearer YOUR_JWT
Content-Type: application/json

{
  "name": "My Team Workspace",
  "display_name": "Your Name"
}
```

---

## 🔍 Additional Diagnostics

### Check if RLS is Enabled:
```sql
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('workspaces', 'workspace_members');
```

Expected output: `rowsecurity = true` for both tables.

### Check Table Structure:
```sql
-- Verify workspaces table
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'workspaces'
ORDER BY ordinal_position;

-- Verify workspace_members table
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'workspace_members'
ORDER BY ordinal_position;
```

Expected columns:

**workspaces:**
- `id` (uuid, not null, default: gen_random_uuid())
- `name` (text, not null)
- `join_code` (text, not null, unique)
- `created_by` (uuid, nullable, FK to auth.users)
- `created_at` (timestamp, default: now())

**workspace_members:**
- `workspace_id` (uuid, not null, FK to workspaces)
- `user_id` (uuid, not null, FK to auth.users)
- `display_name` (text, not null)
- `role` (text, not null, CHECK constraint)
- `joined_at` (timestamp, default: now())
- Primary Key: (workspace_id, user_id)

---

## 🧪 Testing Endpoints

### 1. Debug Endpoint (Check Table Access)
```bash
GET /api/workspaces/debug
Authorization: Bearer YOUR_JWT
```

This will show if tables are accessible and what errors occur.

### 2. Test Endpoint (Step-by-Step Diagnostics)
```bash
POST /api/workspaces/test
Authorization: Bearer YOUR_JWT
Content-Type: application/json

{
  "name": "Test Workspace",
  "display_name": "Test User"
}
```

This will show exactly which step fails (auth, workspace insert, or member insert).

### 3. Create Workspace (Production Endpoint)
```bash
POST /api/workspaces/create
Authorization: Bearer YOUR_JWT
Content-Type: application/json

{
  "name": "Frontend Team",
  "display_name": "Alice"
}
```

Expected response:
```json
{
  "workspace_id": "uuid-here",
  "join_code": "ABC123"
}
```

---

## 🚨 Common Issues & Solutions

### Issue 1: "relation 'workspaces' does not exist"
**Solution:** Tables haven't been created yet. Run the schema creation SQL first.

### Issue 2: "column 'created_by' does not exist"
**Solution:** Column name mismatch. Check your actual schema and update the API code accordingly.

### Issue 3: "duplicate key value violates unique constraint"
**Solution:** Join code collision (very rare). The endpoint will retry automatically, or you can manually retry.

### Issue 4: "permission denied for table workspaces"
**Solution:** RLS is enabled but no policies exist. Run the RLS policies SQL script.

### Issue 5: "new row violates row-level security policy"
**Solution:** This is your current issue. RLS policies are missing or incorrect. Apply the policies from `supabase_rls_policies.sql`.

### Issue 6: User can create workspace but not join as member
**Solution:** The `workspace_members` table needs an INSERT policy. Ensure the "Users can join workspaces" policy exists.

### Issue 7: "infinite recursion detected in policy"
**Solution:** The SELECT policy on `workspace_members` is referencing itself. Use the non-recursive version:
```sql
-- Non-recursive (GOOD)
CREATE POLICY "Users can read their own memberships"
ON workspace_members FOR SELECT
USING (user_id = auth.uid());

-- Instead of recursive (BAD)
CREATE POLICY "Users can read workspace members"
ON workspace_members FOR SELECT
USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
```

---

## 🔐 Security Notes

### RLS Policy Behavior:
- **WITH CHECK**: Controls what rows can be INSERTED or UPDATED
- **USING**: Controls what rows can be SELECTED, UPDATED, or DELETED
- **auth.uid()**: Returns the authenticated user's ID from the JWT

### Service Role Bypass:
The `createAdminClient()` uses the service role key, which **bypasses all RLS policies**. This is why async background tasks work even without user context.

### Policy Testing:
You can test policies by:
1. Creating a test user in Supabase Auth
2. Getting their JWT token
3. Using that token in API requests
4. Checking if they can only access their own data

---

## 📊 Expected Behavior After Fix

### Create Workspace Flow:
1. User authenticates → JWT validated
2. User creates workspace → RLS allows INSERT (created_by = auth.uid())
3. User added as ADMIN member → RLS allows INSERT (user_id = auth.uid())
4. Returns workspace_id and join_code

### Join Workspace Flow:
1. User authenticates → JWT validated
2. User looks up workspace by join_code → RLS allows SELECT (after joining)
3. User inserts themselves as MEMBER → RLS allows INSERT (user_id = auth.uid())
4. Returns workspace_id

### List Workspaces Flow:
1. User authenticates → JWT validated
2. Query workspace_members for user's memberships → RLS allows SELECT
3. Join with workspaces table → RLS allows SELECT (user is member)
4. Returns array of workspaces with user's role

---

## 🎯 Next Steps

1. ✅ Apply RLS policies from `supabase_rls_policies.sql`
2. ✅ Test `/api/workspaces/create` endpoint
3. ✅ Test `/api/workspaces/join` endpoint
4. ✅ Test `/api/workspaces` (list) endpoint
5. ✅ Test ingestion with `workspace_id`
6. ✅ Test chat with `workspace_id`

Once RLS policies are applied, all endpoints should work correctly!

---

## 📞 Still Having Issues?

If you continue to see errors after applying RLS policies:

1. Check the Supabase logs for detailed error messages
2. Verify your JWT token is valid (not expired)
3. Ensure the user exists in `auth.users`
4. Check if there are any database triggers interfering
5. Verify foreign key constraints are properly set up

Share the specific error message and I can provide more targeted help!
