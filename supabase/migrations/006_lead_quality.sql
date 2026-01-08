-- Migration: Add lead quality columns for Lead Heat feature
--
-- Adds columns to track quality tier selection and aggregate quality metrics
-- per export. Used for:
-- 1. Recording which tier was used for generation
-- 2. Storing aggregate quality stats for analysis
-- 3. Tracking intent pack used for keyword expansion
--
-- To apply: `supabase db push` or run in Supabase Dashboard SQL Editor

-- Add quality_tier column (hot | balanced | scale)
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS quality_tier TEXT DEFAULT 'balanced';

-- Add intent_pack column (which pack was matched for keyword expansion)
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS intent_pack TEXT;

-- Add average quality score column (0-100)
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS avg_quality_score NUMERIC(5,1);

-- Add max quality score column
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS max_quality_score INT;

-- Add quality distribution columns (for analytics)
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS high_quality_count INT DEFAULT 0;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS medium_quality_count INT DEFAULT 0;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS low_quality_count INT DEFAULT 0;

-- Quality Gate columns (track what was delivered vs rejected)
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS delivered_count INT DEFAULT 0;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS rejected_by_quality_count INT DEFAULT 0;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS min_quality_score_used INT;

-- Extended quality report columns
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS p90_quality_score INT;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS pct_wireless INT;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS pct_with_address INT;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS match_score_distribution JSONB;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS quality_gate_warning TEXT;

-- Column comments
COMMENT ON COLUMN public.lead_exports.quality_tier IS 'Quality tier used for generation: hot (max conversion), balanced (default), scale (more volume)';
COMMENT ON COLUMN public.lead_exports.intent_pack IS 'Intent pack matched for keyword expansion (e.g., remodeling, roofing, home_services)';
COMMENT ON COLUMN public.lead_exports.avg_quality_score IS 'Average quality score (0-100) across all leads in export';
COMMENT ON COLUMN public.lead_exports.max_quality_score IS 'Maximum quality score in export';
COMMENT ON COLUMN public.lead_exports.high_quality_count IS 'Count of leads with quality_score >= 70';
COMMENT ON COLUMN public.lead_exports.medium_quality_count IS 'Count of leads with quality_score >= 50 and < 70';
COMMENT ON COLUMN public.lead_exports.low_quality_count IS 'Count of leads with quality_score < 50';
COMMENT ON COLUMN public.lead_exports.delivered_count IS 'Number of leads delivered after quality gate filtering';
COMMENT ON COLUMN public.lead_exports.rejected_by_quality_count IS 'Number of leads rejected by quality gate (below tier threshold)';
COMMENT ON COLUMN public.lead_exports.min_quality_score_used IS 'Minimum quality score threshold used for this export';
COMMENT ON COLUMN public.lead_exports.p90_quality_score IS '90th percentile quality score (top 10%)';
COMMENT ON COLUMN public.lead_exports.pct_wireless IS 'Percentage of delivered leads with wireless phone';
COMMENT ON COLUMN public.lead_exports.pct_with_address IS 'Percentage of delivered leads with full address';
COMMENT ON COLUMN public.lead_exports.match_score_distribution IS 'Distribution of match scores as JSON {score0, score1, score2, score3}';
COMMENT ON COLUMN public.lead_exports.quality_gate_warning IS 'Warning message if fewer leads delivered than requested due to quality gate';

-- Verification query (run after migration to confirm columns exist)
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'lead_exports'
-- AND column_name IN (
--   'quality_tier', 'intent_pack', 'avg_quality_score', 'max_quality_score',
--   'high_quality_count', 'medium_quality_count', 'low_quality_count',
--   'delivered_count', 'rejected_by_quality_count', 'min_quality_score_used',
--   'p90_quality_score', 'pct_wireless', 'pct_with_address', 'match_score_distribution',
--   'quality_gate_warning'
-- )
-- ORDER BY column_name;
