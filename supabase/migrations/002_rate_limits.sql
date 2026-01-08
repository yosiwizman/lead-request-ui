-- Migration: Create rate_limits table for API rate limiting
-- 
-- Uses a sliding window approach with PostgreSQL for simple, no-dependency rate limiting.
-- Each row tracks request count for a session+route+window combination.
--
-- To apply this migration:
-- Option A: If using Supabase CLI: `supabase db push`
-- Option B: Copy this SQL into Supabase Dashboard > SQL Editor and run

-- Create rate_limits table
CREATE TABLE IF NOT EXISTS public.rate_limits (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Composite key for rate limiting
  session_hash TEXT NOT NULL,           -- SHA256 hash of session token (no PII)
  route_key TEXT NOT NULL,              -- Route identifier (e.g., 'generate', 'status')
  window_start TIMESTAMPTZ NOT NULL,    -- Start of the rate limit window
  
  -- Counter
  request_count INT NOT NULL DEFAULT 1, -- Number of requests in this window
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Unique constraint for upsert
  CONSTRAINT rate_limits_unique UNIQUE (session_hash, route_key, window_start)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup 
  ON public.rate_limits (session_hash, route_key, window_start DESC);

-- Index for cleanup of old windows
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start 
  ON public.rate_limits (window_start);

-- Auto-update updated_at timestamp
-- (Reuse existing function if available, otherwise create)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    CREATE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $func$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS update_rate_limits_updated_at ON public.rate_limits;
CREATE TRIGGER update_rate_limits_updated_at
  BEFORE UPDATE ON public.rate_limits
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Cleanup function for old rate limit windows (call periodically)
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits(retention_hours INT DEFAULT 24)
RETURNS INT AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM public.rate_limits
  WHERE window_start < NOW() - (retention_hours || ' hours')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Comment on table
COMMENT ON TABLE public.rate_limits IS 'API rate limiting windows (no PII - only session hashes)';
COMMENT ON FUNCTION cleanup_old_rate_limits(INT) IS 'Cleanup old rate limit windows. Default retention: 24 hours.';
