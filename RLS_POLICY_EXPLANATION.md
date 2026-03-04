# Understanding RLS Policy Recursion in MindStack Workspaces

## The Problem: Infinite Recursion (Error 42P17)

### What Happened?
When you tried to create a workspace, PostgreSQL threw this error:
```
infinite recursion detected in policy for relation "workspace_members"
```

### Why Did This Happen?

#### The Recursive Policy (BAD ❌)
```sql
CREATE POLICY "Users can read workspace members"
ON workspace_members FOR SELECT
TO authenticated
USING (
    workspace_id IN (
        SELECT workspace_id 
        FROM workspace_members  -- ← Problem: References same table!
        WHERE user_id = auth.uid()
    )
);
```

#### The Execution Flow (Infinite Loop)
1. User tries to INSERT into `workspaces` table
2. Workspace INSERT succeeds
3. User tries to INSERT into `workspace_members` table
4. Before INSERT, PostgreSQL checks if user can SELECT from `workspace_members` (for validation)
5. The SELECT policy runs: `workspace_id IN (SELECT workspace_id FROM workspace_members ...)`
6. This SELECT triggers the same policy again (step 5)
7. Which triggers another SELECT (step 5)
8. Which triggers another SELECT (step 5)
9. **→ Infinite recursion! PostgreSQL aborts.**

---

## The Solution: Non-Recursive Policies

### The Fixed Policy (GOOD ✅)
```sql
CREATE POLICY "Users can read their own memberships"
ON workspace_members FOR SELECT
TO authenticated
USING (user_id = auth.uid());  -- ← Direct comparison, no subquery
```

### Why This Works
1. User tries to INSERT into `workspace_members`
2. PostgreSQL checks the SELECT policy
3. The policy evaluates: `user_id = auth.uid()` (simple comparison on current row)
4. **No subquery → No recursion → Success!**

---

## Key Principles for RLS Policies

### ✅ DO: Use Direct Row Comparisons
```sql
-- Good: Checks only the current row
USING (user_id = auth.uid())
USING (created_by = auth.uid())
USING (owner_id = auth.uid())
```

### ✅ DO: Use EXISTS with Different Tables
```sql
-- Good: References a different table
USING (
    EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = workspaces.id  -- workspaces ≠ workspace_members
        AND wm.user_id = auth.uid()
    )
)
```

### ❌ DON'T: Use Subqueries on Same Table
```sql
-- Bad: Creates recursion
USING (
    workspace_id IN (
        SELECT workspace_id FROM workspace_members  -- Same table!
        WHERE user_id = auth.uid()
    )
)
```

### ❌ DON'T: Use IN with Same Table
```sql
-- Bad: Creates recursion
USING (
    id IN (SELECT workspace_id FROM workspace_members WHERE ...)
)
```

---

## The Correct Policy Order

### 1. Create workspace_members Policies FIRST
```sql
-- Non-recursive: only checks current row
CREATE POLICY "Users can read their own memberships"
ON workspace_members FOR SELECT
USING (user_id = auth.uid());
```

### 2. Then Create workspaces Policies
```sql
-- Safe: references workspace_members which has non-recursive policy
CREATE POLICY "Users can read their workspaces"
ON workspaces FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = workspaces.id
        AND wm.user_id = auth.uid()
    )
);
```

---

## Real-World Example: MindStack Workspace Creation

### The Flow with Correct Policies

#### Step 1: User Creates Workspace
```sql
INSERT INTO workspaces (name, join_code, created_by)
VALUES ('My Team', 'ABC123', 'user-uuid');
```
- **Policy Check:** `created_by = auth.uid()` ✅
- **Result:** Workspace created

#### Step 2: User Joins as Admin
```sql
INSERT INTO workspace_members (workspace_id, user_id, display_name, role)
VALUES ('workspace-uuid', 'user-uuid', 'Alice', 'ADMIN');
```
- **Policy Check:** `user_id = auth.uid()` ✅
- **Result:** Member added

#### Step 3: User Lists Workspaces
```sql
SELECT * FROM workspaces WHERE ...;
```
- **Policy Check:** 
  ```sql
  EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = workspaces.id
      AND wm.user_id = auth.uid()
  )
  ```
- **workspace_members SELECT triggered:** `user_id = auth.uid()` ✅
- **No recursion!** The workspace_members policy doesn't reference itself
- **Result:** Workspaces returned

---

## Debugging RLS Issues

### Check Current Policies
```sql
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename IN ('workspaces', 'workspace_members')
ORDER BY tablename, policyname;
```

### Drop Problematic Policies
```sql
DROP POLICY IF EXISTS "Users can read workspace members" ON workspace_members;
DROP POLICY IF EXISTS "Users can read their workspaces" ON workspaces;
```

### Test Policy Logic
```sql
-- Test as a specific user
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims.sub TO 'user-uuid-here';

-- Try to select
SELECT * FROM workspace_members WHERE user_id = 'user-uuid-here';
```

---

## Common RLS Patterns

### Pattern 1: Own Records Only
```sql
-- Users can only see/modify their own records
CREATE POLICY "users_own_records"
ON table_name FOR ALL
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
```

### Pattern 2: Team Members (Non-Recursive)
```sql
-- Step 1: Team members can see their own membership
CREATE POLICY "read_own_membership"
ON team_members FOR SELECT
USING (user_id = auth.uid());

-- Step 2: Users can see teams they belong to
CREATE POLICY "read_own_teams"
ON teams FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = teams.id
        AND tm.user_id = auth.uid()
    )
);
```

### Pattern 3: Role-Based Access
```sql
-- Admins can do everything, members can only read
CREATE POLICY "role_based_access"
ON resources FOR ALL
USING (
    EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = resources.team_id
        AND tm.user_id = auth.uid()
        AND (
            tm.role = 'ADMIN'
            OR (tm.role = 'MEMBER' AND current_setting('request.method') = 'GET')
        )
    )
);
```

---

## Summary

### The Golden Rule
**Never reference the same table in a SELECT policy's USING clause.**

### The Fix for MindStack
1. ✅ `workspace_members` SELECT policy: `USING (user_id = auth.uid())`
2. ✅ `workspaces` SELECT policy: `USING (EXISTS (SELECT 1 FROM workspace_members ...))`
3. ✅ Order matters: Create `workspace_members` policies first

### Result
- No infinite recursion
- Users can create workspaces
- Users can join workspaces
- Users can list their workspaces
- Full security isolation maintained

---

## Additional Resources

- [Supabase RLS Documentation](https://supabase.com/docs/guides/auth/row-level-security)
- [PostgreSQL RLS Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- MindStack Files:
  - `supabase_rls_policies.sql` - Complete policy definitions
  - `QUICK_FIX.md` - Fast copy-paste solution
  - `WORKSPACE_TROUBLESHOOTING.md` - Comprehensive troubleshooting
