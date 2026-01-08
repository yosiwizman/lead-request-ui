-- Migration: Add polling tracking and compliance suppression columns
--
-- Adds support for:
-- 1. Tracking poll attempts for building audiences
-- 2. Recording suppressed lead counts for compliance
--
-- To apply: `supabase db push` or run in Supabase Dashboard SQL Editor

-- Add poll_attempts column to track how many times status was polled
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS poll_attempts INT DEFAULT 0;

-- Add last_polled_at to track when last poll occurred
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ NULL;

-- Add suppressed_count for compliance filtering (e.g., TX state suppression for calls)
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS suppressed_count INT DEFAULT 0;

-- Add suppressed_states to record which states were suppressed
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS suppressed_states TEXT[] NULL;

-- Comments
COMMENT ON COLUMN public.lead_exports.poll_attempts IS 'Number of times /api/leads/status was polled for this export';
COMMENT ON COLUMN public.lead_exports.last_polled_at IS 'Timestamp of most recent poll attempt';
COMMENT ON COLUMN public.lead_exports.suppressed_count IS 'Number of leads filtered out by state suppression (compliance)';
COMMENT ON COLUMN public.lead_exports.suppressed_states IS 'Array of state codes that were suppressed (e.g., TX)';
