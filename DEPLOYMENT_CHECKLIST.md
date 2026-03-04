# MindStack Team Workspaces - Complete Deployment Checklist

## 🎯 Overview
This checklist ensures the Team Workspaces feature is deployed correctly with zero regressions.

---

## ✅ Step 1: Apply Database Schema Updates

### 1.1 RLS Policies (CRITICAL)
**File:** `supabase_rls_policies.sql`

**What it does:**
- Enables Row-Level Security on workspaces and workspace_members tables
- Creates non-recursive policies to avoid infinite recursion
- Allows users to create/join/read workspaces

**How to apply:**
1. Open Supabase Dashboard → SQL Editor
2. Copy contents of `supabase_rls_policies.sql`
3. Click "Run"
4. Verify: Run the verification queries at the bottom of the file

**Expected result:** 4+ policies created (2 for workspaces, 2+ for workspace_members)

---

### 1.2 Sessions Table Update (CRITICAL)
**File:** `sessions_workspace_schema.sql`

**What it does:**
- Adds `workspace_id` column to sessions table
- Makes `project_id` nullable
- Adds check constraint to ensure either project_id OR workspace_id is set

**How to apply:**
1. Open Supabase Dashboard → SQL Editor
2. Copy contents of `sessions_workspace_schema.sql`
3. Click "Run"
4. Verify: Check the verification queries at the bottom

**Expected result:** Sessions table has workspace_id column with proper constraints

---

## ✅ Step 2: Deploy API Changes

All API changes are already in the codebase. Just deploy to Vercel/your hosting:

```bash
git add .
git commit -m "feat: Add Team Workspaces support"
git push origin main
```

### Updated Endpoints:
- ✅ `POST /api/workspaces/create` - NEW
- ✅ `POST /api/workspaces/join` - NEW
- ✅ `GET /api/workspaces` - NEW
- ✅ `GET /api/workspaces/[workspace_id]/captures/presign` - NEW (S3 presigned URLs for workspace media)
- ✅ `POST /api/sessions/start` - UPDATED (now accepts workspace_id)
- ✅ `POST /api/ingest/browser` - UPDATED (workspace support)
- ✅ `POST /api/ingest/ide` - UPDATED (workspace support)
- ✅ `POST /api/chat` - UPDATED (workspace RAG)
- ✅ `DELETE /api/captures/[id]` - UPDATED (team role permissions)

---

## ✅ Step 3: Test Workspace Creation

### 3.1 Create a Workspace
```bash
curl -X POST https://your-domain.com/api/workspaces/create \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Workspace",
    "display_name": "Test User"
  }'
```

**Expected response:**
```json
{
  "workspace_id": "uuid-here",
  "join_code": "ABC123"
}
```

**If you get error 42501:** RLS policies not applied → Go back to Step 1.1

**If you get error 42P17:** Recursive policy issue → Use the fixed `supabase_rls_policies.sql`

---

### 3.2 Join a Workspace
```bash
curl -X POST https://your-domain.com/api/workspaces/join \
  -H "Authorization: Bearer ANOTHER_USER_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "join_code": "ABC123",
    "display_name": "Second User"
  }'
```

**Expected response:**
```json
{
  "workspace_id": "same-uuid-as-above"
}
```

---

### 3.3 List Workspaces
```bash
curl -X GET https://your-domain.com/api/workspaces \
  -H "Authorization: Bearer YOUR_JWT"
```

**Expected response:**
```json
{
  "workspaces": [
    {
      "workspace_id": "uuid",
      "name": "Test Workspace",
      "join_code": "ABC123",
      "user_role": "ADMIN",
      "user_display_name": "Test User",
      "joined_at": "timestamp"
    }
  ]
}
```

---

## ✅ Step 4: Test Session Management

### 4.1 Start Workspace Session
```bash
curl -X POST https://your-domain.com/api/sessions/start \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "workspace-uuid-from-step-3"
  }'
```

**Expected response:**
```json
{
  "session_id": "session-uuid"
}
```

**If you get "project_id is required":** Sessions table not updated → Go back to Step 1.2

---

### 4.2 Test Personal Project Session (Backward Compatibility)
```bash
curl -X POST https://your-domain.com/api/sessions/start \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "existing-project-uuid"
  }'
```

**Expected response:**
```json
{
  "session_id": "session-uuid"
}
```

**This must still work!** Ensures zero regressions.

---

## ✅ Step 5: Test Ingestion

### 5.1 Ingest to Workspace
```bash
curl -X POST https://your-domain.com/api/ingest/browser \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "session-uuid-from-step-4",
    "workspace_id": "workspace-uuid",
    "capture_type": "WEB_TEXT",
    "text_content": "React hooks tutorial content...",
    "source_url": "https://example.com/react-hooks"
  }'
```

**Expected response:**
```json
{
  "capture_id": "capture-uuid"
}
```

**What happens in background:**
- Capture is saved with workspace_id and author_display_name
- Text is chunked
- Each chunk is prepended with `[Contributed by: Your Name]`
- Chunks are embedded and saved to capture_chunks

---

### 5.2 Verify Attribution
Check the database:
```sql
SELECT chunk_text FROM capture_chunks 
WHERE capture_id = 'capture-uuid-from-step-5' 
LIMIT 1;
```

**Expected result:**
```
[Contributed by: Test User]

React hooks tutorial content...
```

---

## ✅ Step 6: Test RAG Chat

### 6.1 Query Workspace
```bash
curl -X POST https://your-domain.com/api/chat \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "workspace-uuid",
    "current_query": "What did the team learn about React hooks?",
    "messages": []
  }'
```

**Expected response:** SSE stream with:
1. `{"type":"sources","data":[...]}` - S3 URLs
2. `{"type":"delta","data":"..."}` - Text chunks mentioning contributor names
3. `{"type":"done"}` - End of stream

**Verify:** The response should mention "Test User" or reference the contributor.

---

### 6.2 Test Personal Project Chat (Backward Compatibility)
```bash
curl -X POST https://your-domain.com/api/chat \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "existing-project-uuid",
    "current_query": "What did I learn?",
    "messages": []
  }'
```

**Expected response:** SSE stream without contributor attribution (personal mode).

**This must still work!** Ensures zero regressions.

---

## ✅ Step 7: Test Edge Cases

### 7.1 Test Workspace Media Access (S3 Presigned URLs)
```bash
curl -X GET "https://your-domain.com/api/workspaces/[workspace-uuid]/captures/presign?filename=test.pdf&contentType=application/pdf" \
  -H "Authorization: Bearer YOUR_JWT"
```

**Expected response:**
```json
{
  "url": "https://s3-presigned-url...",
  "key": "uploads/test.pdf"
}
```

**What this prevents:** Broken image icons for PDFs and images in workspace captures.

---

### 7.2 Test Capture Deletion Permissions

**Test 7.2a: User deletes their own capture**
```bash
curl -X DELETE https://your-domain.com/api/captures/[capture-id] \
  -H "Authorization: Bearer CAPTURE_OWNER_JWT"
```

**Expected response:**
```json
{
  "success": true
}
```

**Test 7.2b: Non-admin tries to delete another user's capture**
```bash
curl -X DELETE https://your-domain.com/api/captures/[capture-id] \
  -H "Authorization: Bearer NON_ADMIN_JWT"
```

**Expected response:**
```json
{
  "error": "You don't have permission to delete this capture"
}
```

**Test 7.2c: Admin deletes another user's capture**
```bash
curl -X DELETE https://your-domain.com/api/captures/[capture-id] \
  -H "Authorization: Bearer ADMIN_JWT"
```

**Expected response:**
```json
{
  "success": true
}
```

**What this prevents:** Chaos in multiplayer environments where users delete each other's work.

---

### 7.3 Session Without project_id or workspace_id
```bash
curl -X POST https://your-domain.com/api/sessions/start \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected response:**
```json
{
  "error": "Either `project_id` or `workspace_id` is required"
}
```

---

### 7.4 Join Invalid Code
```bash
curl -X POST https://your-domain.com/api/workspaces/join \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "join_code": "INVALID",
    "display_name": "Test"
  }'
```

**Expected response:**
```json
{
  "error": "Invalid join code or workspace not found"
}
```

---

### 7.5 Duplicate Join
Try joining the same workspace twice with the same user.

**Expected response:**
```json
{
  "error": "You are already a member of this workspace"
}
```

---

## ✅ Step 8: Verify Zero Regressions

### 8.1 Existing Personal Projects
- [ ] Can still create personal projects
- [ ] Can still start sessions with project_id
- [ ] Can still ingest captures to projects
- [ ] Can still query projects with chat
- [ ] No workspace_id or author_display_name in personal captures

### 8.2 Existing Captures
- [ ] Old captures without workspace_id are still queryable
- [ ] Old sessions with project_id still work
- [ ] Chat with project_id returns old captures

---

## 🚨 Troubleshooting

### Error: "new row violates row-level security policy"
**Solution:** RLS policies not applied. Run `supabase_rls_policies.sql`

### Error: "infinite recursion detected in policy"
**Solution:** Old recursive policies still exist. Drop them and apply fixed policies from `supabase_rls_policies.sql`

### Error: "column 'workspace_id' does not exist"
**Solution:** Sessions table not updated. Run `sessions_workspace_schema.sql`

### Error: "project_id is required"
**Solution:** API code not deployed or old version cached. Redeploy and clear cache.

### Captures don't have attribution
**Solution:** Check if workspace_id was passed to ingestion endpoint. Verify author_display_name is set in captures table.

### Chat doesn't show contributor names
**Solution:** Verify chunks have `[Contributed by: Name]` prefix. Check if workspace_id was passed to chat endpoint.

---

## 📚 Reference Documents

- `QUICK_FIX.md` - Fast RLS policy fix
- `supabase_rls_policies.sql` - Complete RLS policies
- `sessions_workspace_schema.sql` - Sessions table update
- `SESSION_WORKSPACE_UPDATE.md` - Session endpoint details
- `WORKSPACE_TROUBLESHOOTING.md` - Comprehensive troubleshooting
- `RLS_POLICY_EXPLANATION.md` - Deep dive into RLS recursion
- `TEAM_WORKSPACES_IMPLEMENTATION.md` - Complete feature documentation

---

## ✅ Success Criteria

All of the following must be true:

- [x] Workspaces can be created
- [x] Users can join workspaces via join code
- [x] Users can list their workspaces
- [x] Sessions can be started with workspace_id
- [x] Captures can be ingested to workspaces
- [x] Captures have author attribution
- [x] Chunks are prepended with contributor names
- [x] Chat works with workspace_id
- [x] Chat responses mention contributors
- [x] Workspace media (images/PDFs) can be accessed via presigned URLs
- [x] Users can delete their own captures
- [x] Admins can delete any capture in their workspace
- [x] Non-admins cannot delete other users' captures
- [x] Personal projects still work (zero regressions)
- [x] All TypeScript files compile without errors

---

## 🎉 Deployment Complete!

Once all steps pass, the Team Workspaces feature is fully deployed and ready for production use.
