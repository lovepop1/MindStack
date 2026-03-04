-- ============================================================================
-- MindStack Team Workspaces - Row-Level Security (RLS) Policies
-- ============================================================================
-- Run this in your Supabase SQL Editor to enable workspace functionality
-- ============================================================================

-- Enable RLS on both tables (if not already enabled)
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- WORKSPACE_MEMBERS TABLE POLICIES (Must come FIRST to avoid recursion)
-- ============================================================================

-- Policy 1: Allow users to INSERT themselves as members
CREATE POLICY "Users can join workspaces"
ON workspace_members
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Policy 2: Allow users to SELECT their own membership records
-- CRITICAL: This is non-recursive - only checks the current row
CREATE POLICY "Users can read their own memberships"
ON workspace_members
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Policy 3: Allow ADMIN members to UPDATE other members' roles
CREATE POLICY "Admins can update members"
ON workspace_members
FOR UPDATE
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = workspace_members.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role = 'ADMIN'
    )
);

-- Policy 4: Allow ADMIN members to DELETE other members
CREATE POLICY "Admins can remove members"
ON workspace_members
FOR DELETE
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = workspace_members.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role = 'ADMIN'
    )
);

-- ============================================================================
-- WORKSPACES TABLE POLICIES
-- ============================================================================

-- Policy 1: Allow authenticated users to INSERT workspaces they create
CREATE POLICY "Users can create workspaces"
ON workspaces
FOR INSERT
TO authenticated
WITH CHECK (created_by = auth.uid());

-- Policy 2: Allow users to SELECT workspaces they are members of
-- Now safe because workspace_members SELECT policy is non-recursive
CREATE POLICY "Users can read their workspaces"
ON workspaces
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = workspaces.id
        AND wm.user_id = auth.uid()
    )
);

-- Policy 3: Allow workspace creators to UPDATE their workspaces
CREATE POLICY "Workspace creators can update"
ON workspaces
FOR UPDATE
TO authenticated
USING (created_by = auth.uid())
WITH CHECK (created_by = auth.uid());

-- Policy 4: Allow workspace creators to DELETE their workspaces
CREATE POLICY "Workspace creators can delete"
ON workspaces
FOR DELETE
TO authenticated
USING (created_by = auth.uid());

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- Run these to verify policies were created successfully:

-- Check workspaces policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE tablename = 'workspaces'
ORDER BY policyname;

-- Check workspace_members policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE tablename = 'workspace_members'
ORDER BY policyname;

-- ============================================================================
-- NOTES
-- ============================================================================
-- 1. CRITICAL: workspace_members policies must be created FIRST to avoid
--    infinite recursion when workspaces policies reference workspace_members
--
-- 2. The key fix: "Users can read their own memberships" policy uses
--    USING (user_id = auth.uid()) which only checks the current row,
--    not a subquery that would trigger the policy recursively
--
-- 3. The admin client (service role) bypasses all RLS policies, which is
--    why async background tasks use createAdminClient()
--
-- 4. If you need to drop and recreate policies, use:
--    DROP POLICY IF EXISTS "policy_name" ON table_name;
-- ============================================================================
