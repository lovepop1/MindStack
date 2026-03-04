# 🚨 QUICK FIX: Error 42501/42P17 - RLS Policy Issues

## The Problem
```
Error 42501: new row violates row-level security policy
Error 42P17: infinite recursion detected in policy
```

## The Solution (2 minutes)

### Step 1: Drop Existing Policies (if any)
Go to: **Supabase Dashboard → SQL Editor → New Query**

```sql
-- Clean slate: drop any existing policies
DROP POLICY IF EXISTS "Users can create workspaces" ON workspaces;
DROP POLICY IF EXISTS "Users can read their workspaces" ON workspaces;
DROP POLICY IF EXISTS "Workspace creators can update" ON workspaces;
DROP POLICY IF EXISTS "Workspace creators can delete" ON workspaces;
DROP POLICY IF EXISTS "Users can join workspaces" ON workspace_members;
DROP POLICY IF EXISTS "Users can read workspace members" ON workspace_members;
DROP POLICY IF EXISTS "Users can read their own memberships" ON workspace_members;
DROP POLICY IF EXISTS "Admins can update members" ON workspace_members;
DROP POLICY IF EXISTS "Admins can remove members" ON workspace_members;
```

### Step 2: Apply Non-Recursive Policies
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

### Step 3: Click "Run"

### Step 4: Test Your Endpoint
```bash
POST /api/workspaces/create
Authorization: Bearer YOUR_JWT

{
  "name": "My Team",
  "display_name": "Your Name"
}
```

## ✅ Expected Result
```json
{
  "workspace_id": "uuid-here",
  "join_code": "ABC123"
}
```

## 🔍 What Was Wrong?

### The Recursive Policy (BAD):
```sql
-- This causes infinite recursion!
CREATE POLICY "Users can read workspace members"
ON workspace_members FOR SELECT
USING (
    workspace_id IN (
        SELECT workspace_id FROM workspace_members  -- ← Triggers same policy!
        WHERE user_id = auth.uid()
    )
);
```

### The Fixed Policy (GOOD):
```sql
-- Non-recursive: only checks current row
CREATE POLICY "Users can read their own memberships"
ON workspace_members FOR SELECT
USING (user_id = auth.uid());  -- ← Direct comparison, no subquery
```

## 📚 More Details
- Full policies: See `supabase_rls_policies.sql`
- Troubleshooting: See `WORKSPACE_TROUBLESHOOTING.md`
- Implementation: See `TEAM_WORKSPACES_IMPLEMENTATION.md`

---

**Key Insight:** When a SELECT policy on table A references table A in a subquery, it creates infinite recursion. The fix is to use direct row-level checks (`user_id = auth.uid()`) instead of subqueries.
