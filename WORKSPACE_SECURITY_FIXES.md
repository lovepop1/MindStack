# Team Workspaces Security & Media Access Fixes

## Overview
This document covers three critical missing pieces for Team Workspaces that were implemented to prevent broken functionality and security issues.

---

## 📋 Fix 1: Workspace Captures Listing (CRITICAL)

### The Problem
Without a workspace-specific captures endpoint, the frontend would have no way to fetch and display the timeline of captures for a workspace. This is the primary UI for viewing team contributions.

### The Solution
Created: `app/api/workspaces/[workspace_id]/captures/route.ts`

**What it does:**
- Fetches all captures for a workspace (ordered by created_at DESC)
- Includes author attribution fields (`author_id`, `author_display_name`)
- Automatically converts S3 URLs to presigned GET URLs (1-hour TTL)
- Verifies user is a workspace member before returning data

**Authorization:**
- User must be a member of the workspace (any role)
- Uses RLS policies to verify membership

**Usage:**
```bash
GET /api/workspaces/[workspace_id]/captures
Authorization: Bearer <jwt>
```

**Response:**
```json
{
  "captures": [
    {
      "id": "uuid",
      "workspace_id": "uuid",
      "author_id": "uuid",
      "author_display_name": "Sarah",
      "capture_type": "WEB_TEXT",
      "source_url": "https://example.com",
      "text_content": "...",
      "created_at": "timestamp",
      "capture_attachments": [
        {
          "id": "uuid",
          "s3_url": "https://presigned-get-url...",
          "file_type": "image/png",
          "file_name": "screenshot.png"
        }
      ]
    }
  ]
}
```

**Key Differences from Project Captures:**
- Includes `author_id` and `author_display_name` for attribution
- Uses `workspace_id` instead of `project_id`
- Verifies workspace membership explicitly

---

## 🔒 Fix 2: Workspace Media Upload (S3 Presigned URLs)

### The Problem
Without a workspace-specific presigned URL endpoint, images and PDFs uploaded to workspace captures would show as broken image icons. The existing `/api/projects/[project_id]/captures/presign` endpoint only works for personal projects.

### The Solution
Created: `app/api/workspaces/[workspace_id]/captures/presign/route.ts`

**What it does:**
- Verifies the user is a member of the workspace
- Generates S3 presigned URLs for uploading media
- Returns both the upload URL and the S3 key

**Authorization:**
- User must be a member of the workspace (any role)
- Uses RLS policies to verify membership

**Usage:**
```bash
GET /api/workspaces/[workspace_id]/captures/presign?filename=image.png&contentType=image/png
Authorization: Bearer <jwt>
```

**Response:**
```json
{
  "url": "https://s3-presigned-url...",
  "key": "uploads/image.png"
}
```

---

## 🛡️ Fix 3: Capture Deletion Permissions

### The Problem
In the original implementation, any user could delete any capture without permission checks. In a multiplayer workspace, this would allow Sarah to delete Adithya's captures, causing chaos.

### The Solution
Updated: `app/api/captures/[id]/route.ts`

**New Permission Logic:**
1. User can always delete their own captures (`capture.author_id === user.id`)
2. Workspace admins can delete any capture in their workspace (`role === 'ADMIN'`)
3. Non-admins cannot delete other users' captures

**Implementation Details:**
```typescript
// Check permissions: user owns the capture OR user is admin in the workspace
let hasPermission = capture.author_id === user.id;

if (!hasPermission && capture.workspace_id) {
    // Check if user is an admin in the workspace
    const { data: membership } = await supabase
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", capture.workspace_id)
        .eq("user_id", user.id)
        .single();

    if (membership?.role === "ADMIN") {
        hasPermission = true;
    }
}

if (!hasPermission) {
    return NextResponse.json(
        { error: "You don't have permission to delete this capture" },
        { status: 403 }
    );
}
```

**Authorization Matrix:**

| Scenario | Can Delete? |
|----------|-------------|
| User deletes their own capture | ✅ Yes |
| Admin deletes any capture in workspace | ✅ Yes |
| Non-admin deletes another user's capture | ❌ No (403 Forbidden) |
| User deletes capture from workspace they're not in | ❌ No (404 Not Found) |

---

## Testing

### Test Workspace Captures Listing
```bash
# Should return all captures with presigned URLs if user is member
curl -X GET "https://your-domain.com/api/workspaces/[workspace-uuid]/captures" \
  -H "Authorization: Bearer YOUR_JWT"

# Should fail with 404 if user is not a member
curl -X GET "https://your-domain.com/api/workspaces/[workspace-uuid]/captures" \
  -H "Authorization: Bearer NON_MEMBER_JWT"
```

### Test Workspace Media Upload
```bash
# Should succeed if user is workspace member
curl -X GET "https://your-domain.com/api/workspaces/[workspace-uuid]/captures/presign?filename=test.pdf&contentType=application/pdf" \
  -H "Authorization: Bearer YOUR_JWT"

# Should fail with 404 if user is not a member
curl -X GET "https://your-domain.com/api/workspaces/[workspace-uuid]/captures/presign?filename=test.pdf&contentType=application/pdf" \
  -H "Authorization: Bearer NON_MEMBER_JWT"
```

### Test Capture Deletion Permissions
```bash
# User deletes their own capture - should succeed
curl -X DELETE https://your-domain.com/api/captures/[capture-id] \
  -H "Authorization: Bearer CAPTURE_OWNER_JWT"

# Non-admin tries to delete another user's capture - should fail with 403
curl -X DELETE https://your-domain.com/api/captures/[capture-id] \
  -H "Authorization: Bearer NON_ADMIN_JWT"

# Admin deletes another user's capture - should succeed
curl -X DELETE https://your-domain.com/api/captures/[capture-id] \
  -H "Authorization: Bearer ADMIN_JWT"
```

---

## Backward Compatibility

All fixes maintain full backward compatibility:

1. **Personal Projects:** The existing `/api/projects/[project_id]/captures` endpoint continues to work for personal projects
2. **Personal Project Media:** The existing `/api/projects/[project_id]/captures/presign` endpoint continues to work
3. **Personal Captures:** Users can still delete their own captures in personal projects without workspace checks

---

## Security Considerations

### Workspace Captures Listing
- Uses existing RLS policies on `workspace_members` table
- Presigned GET URLs expire after 1 hour
- Fails gracefully with 404 if user is not a member

### Workspace Media Upload
- Uses existing RLS policies on `workspace_members` table
- No additional database policies needed
- Fails gracefully with 404 if user is not a member

### Capture Deletion
- Prevents unauthorized deletion in multiplayer environments
- Admins have moderation capabilities
- Personal project captures remain unaffected

---

## Files Modified

1. **Created:** `app/api/workspaces/[workspace_id]/captures/route.ts`
   - New endpoint for listing workspace captures with presigned URLs

2. **Created:** `app/api/workspaces/[workspace_id]/captures/presign/route.ts`
   - New endpoint for workspace media upload

3. **Updated:** `app/api/captures/[id]/route.ts`
   - Added permission checks for deletion
   - Checks author ownership and workspace admin role

4. **Updated:** `DEPLOYMENT_CHECKLIST.md`
   - Added testing steps for all three fixes
   - Updated success criteria

---

## Next Steps

1. Deploy the changes to your environment
2. Run the test cases in `DEPLOYMENT_CHECKLIST.md` Step 7.1, 7.2, and 7.3
3. Verify workspace captures timeline displays correctly
4. Verify images/PDFs display correctly in workspace captures
5. Verify deletion permissions work as expected

---

## Related Documents

- `DEPLOYMENT_CHECKLIST.md` - Complete deployment guide
- `TEAM_WORKSPACES_IMPLEMENTATION.md` - Full feature documentation
- `supabase_rls_policies.sql` - RLS policies for workspaces
