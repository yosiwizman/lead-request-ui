-- Migration: Add request_payload column for debugging AudienceLab requests
-- 
-- Stores the sanitized (no secrets) payload sent to AudienceLab for each generation.
-- Allows inspection of exactly what filters were applied.
--
-- To apply this migration:
-- Option A: If using Supabase CLI: `supabase db push`
-- Option B: Copy this SQL into Supabase Dashboard > SQL Editor and run

-- Add request_payload column to lead_exports table
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS request_payload JSONB NULL;

-- Add requested_count column to track how many leads were requested
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS requested_count INT NULL;

-- Comment on new columns
COMMENT ON COLUMN public.lead_exports.request_payload IS 'Sanitized AudienceLab request payload (no secrets) for debugging';
COMMENT ON COLUMN public.lead_exports.requested_count IS 'Number of leads requested (may differ from kept due to filtering/availability)';
