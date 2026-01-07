-- Migration: Create lead_exports table for tracking export history
-- 
-- This table stores METADATA ONLY - no raw PII lead data.
-- Allows users to:
-- 1. View past export requests
-- 2. Regenerate signed URLs for existing exports
--
-- To apply this migration:
-- Option A: If using Supabase CLI: `supabase db push`
-- Option B: Copy this SQL into Supabase Dashboard > SQL Editor and run

-- Create lead_exports table
CREATE TABLE IF NOT EXISTS public.lead_exports (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Request metadata (not PII)
  provider TEXT NOT NULL,              -- 'audiencelab' | 'mock'
  lead_request TEXT NOT NULL,          -- Search query/keywords
  zip_codes TEXT[] NOT NULL,           -- Array of ZIP codes
  target TEXT NOT NULL,                -- 'residential' | 'commercial' | 'both'
  use_case TEXT NOT NULL,              -- 'call' | 'email' | 'both'
  
  -- AudienceLab reference
  audience_id TEXT NULL,               -- AudienceLab audience ID if applicable
  request_id TEXT NULL,                -- Our correlation ID
  
  -- Status tracking
  status TEXT NOT NULL,                -- 'building' | 'success' | 'no_results' | 'error'
  error_code TEXT NULL,                -- Error code if status='error'
  error_message TEXT NULL,             -- Error message (no PII)
  
  -- Counts (no PII - just numbers)
  total_fetched INT NULL,              -- Raw contacts from provider
  kept INT NULL,                       -- Contacts after quality filtering
  
  -- Diagnostics (aggregated counts - no PII)
  diagnostics JSONB NULL,              -- Quality summary (filtered counts, tier breakdown)
  field_coverage JSONB NULL,           -- Field presence percentages
  
  -- Storage reference (for signed URL regeneration)
  bucket TEXT NULL,                    -- Storage bucket name ('exports')
  path TEXT NULL,                      -- File path in bucket
  
  -- Signed URL tracking
  last_signed_url_at TIMESTAMPTZ NULL  -- When a signed URL was last generated
);

-- Index for listing exports by date (most recent first)
CREATE INDEX IF NOT EXISTS idx_lead_exports_created_at 
  ON public.lead_exports (created_at DESC);

-- Index for looking up by audience_id (for status updates)
CREATE INDEX IF NOT EXISTS idx_lead_exports_audience_id 
  ON public.lead_exports (audience_id) 
  WHERE audience_id IS NOT NULL;

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_lead_exports_updated_at ON public.lead_exports;
CREATE TRIGGER update_lead_exports_updated_at
  BEFORE UPDATE ON public.lead_exports
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (optional - disable if using service role only)
-- ALTER TABLE public.lead_exports ENABLE ROW LEVEL SECURITY;

-- Comment on table
COMMENT ON TABLE public.lead_exports IS 'Export history metadata (no PII) for tracking and signed URL regeneration';
