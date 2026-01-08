-- Migration: Add support for async long-build processing
--
-- When audience builds take longer than 30 interactive poll attempts (~25 minutes),
-- the export transitions to 'building_long' status and is processed by a background cron.
--
-- Changes:
-- 1. Add next_poll_at column for scheduling background checks
-- 2. Add index for efficient cron queries
-- 3. Status field already supports text values; 'building_long' is a new valid value
--
-- To apply: `supabase db push` or run in Supabase Dashboard SQL Editor

-- Add next_poll_at column - when background processor should next check this export
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ NULL;

-- Comment
COMMENT ON COLUMN public.lead_exports.next_poll_at IS 'When background processor should next check this export (null = immediate or N/A)';

-- Create index for efficient background processing queries
-- This index helps the cron job quickly find exports that need processing
CREATE INDEX IF NOT EXISTS idx_lead_exports_background_processing 
ON public.lead_exports (status, next_poll_at)
WHERE status IN ('building', 'building_long');

-- Note: The 'status' column is TEXT, so 'building_long' is already supported
-- Valid status values after this migration:
--   - 'building'       : Initial build in progress (interactive polling)
--   - 'building_long'  : Build taking longer than expected (background processing)
--   - 'success'        : Export completed successfully
--   - 'no_results'     : Provider returned no matching leads
--   - 'error'          : Terminal failure (auth error, provider error, etc.)
