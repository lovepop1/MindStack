-- ============================================================================
-- MindStack Sessions Table - Workspace Support
-- ============================================================================
-- Run this in your Supabase SQL Editor to add workspace support to sessions
-- ============================================================================

-- Add workspace_id column to sessions table
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

-- Make project_id nullable (if not already)
-- This allows sessions to be tied to either a project OR a workspace
ALTER TABLE sessions 
ALTER COLUMN project_id DROP NOT NULL;

-- Add check constraint to ensure either project_id OR workspace_id is set
-- This prevents sessions from being orphaned or tied to both
ALTER TABLE sessions
DROP CONSTRAINT IF EXISTS sessions_project_or_workspace_check;

ALTER TABLE sessions
ADD CONSTRAINT sessions_project_or_workspace_check
CHECK (
    (project_id IS NOT NULL AND workspace_id IS NULL) OR
    (project_id IS NULL AND workspace_id IS NOT NULL)
);

-- Create index for workspace_id lookups (performance optimization)
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id 
ON sessions(workspace_id) 
WHERE workspace_id IS NOT NULL;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check the sessions table structure
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'sessions'
ORDER BY ordinal_position;

-- Check constraints
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'sessions';

-- ============================================================================
-- TEST QUERIES
-- ============================================================================

-- Test 1: Create a personal project session (should succeed)
-- INSERT INTO sessions (project_id, start_time, last_active_at)
-- VALUES ('your-project-uuid', NOW(), NOW());

-- Test 2: Create a workspace session (should succeed)
-- INSERT INTO sessions (workspace_id, start_time, last_active_at)
-- VALUES ('your-workspace-uuid', NOW(), NOW());

-- Test 3: Create a session with both (should fail due to constraint)
-- INSERT INTO sessions (project_id, workspace_id, start_time, last_active_at)
-- VALUES ('project-uuid', 'workspace-uuid', NOW(), NOW());

-- Test 4: Create a session with neither (should fail due to constraint)
-- INSERT INTO sessions (start_time, last_active_at)
-- VALUES (NOW(), NOW());

-- ============================================================================
-- NOTES
-- ============================================================================
-- 1. Existing sessions with project_id will continue to work
-- 2. New sessions can be created with either project_id OR workspace_id
-- 3. The check constraint ensures data integrity
-- 4. The index improves query performance for workspace sessions
-- 5. ON DELETE CASCADE ensures sessions are deleted when workspace is deleted
-- ============================================================================
