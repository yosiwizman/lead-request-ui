# Operations: Database Migrations

This document provides instructions for applying database migrations to production via Supabase.

## Methods

### Option 1: Supabase CLI (Recommended)
```bash
npx supabase db push --linked
```

### Option 2: SQL Editor (Manual)
Copy the SQL below into the Supabase Dashboard SQL Editor and execute.

---

## Production Migration: 006 - Lead Quality + Quality Gate

**Purpose:** Adds lead quality scoring columns and quality gate filtering support for tier-based export quality control.

**When to apply:** After deploying the Quality Gate feature.

**Prerequisites:**
- Migration 005 (next_poll_at, background processing index) must be applied first

### SQL for Supabase SQL Editor

Copy and paste this entire block into the SQL Editor:

```sql
-- Migration 006: Lead Quality + Quality Gate
-- Adds quality scoring and tier-based filtering support
--
-- Safe to run multiple times (idempotent with IF NOT EXISTS)

-- Lead Heat quality columns
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS quality_tier TEXT;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS intent_pack TEXT;

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS avg_quality_score DECIMAL(5,2);

ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS max_quality_score INT;

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
COMMENT ON COLUMN public.lead_exports.match_score_distribution IS 'Distribution of match scores as JSON {score_0, score_1, score_2, score_3, score_4, score_5_plus}';
COMMENT ON COLUMN public.lead_exports.quality_gate_warning IS 'Warning message if fewer leads delivered than requested due to quality gate';

-- Verification: Check all new columns were added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'lead_exports' 
AND column_name IN (
  'quality_tier', 'intent_pack', 'avg_quality_score', 'max_quality_score',
  'high_quality_count', 'medium_quality_count', 'low_quality_count',
  'delivered_count', 'rejected_by_quality_count', 'min_quality_score_used',
  'p90_quality_score', 'pct_wireless', 'pct_with_address', 'match_score_distribution',
  'quality_gate_warning'
)
ORDER BY column_name;
```

### Expected Output

After successful execution, the verification query should return 15 rows showing all new columns.

---

## Production Migration: 005 - Long Build Async Processing

**Purpose:** Adds support for async background processing of long-running audience builds.

**When to apply:** After deploying the `building_long` status feature (PR #22).

**Prerequisites:**
- Migration 004 (poll_attempts, last_polled_at, suppressed_count, suppressed_states) must be applied first

### SQL for Supabase SQL Editor

Copy and paste this entire block into the SQL Editor:

```sql
-- Migration 005: Long Build Async Processing
-- Adds support for background processing of long-running audience builds
--
-- Safe to run multiple times (idempotent with IF NOT EXISTS)

-- 1. Add next_poll_at column for scheduling background checks
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ NULL;

-- 2. Add column comment
COMMENT ON COLUMN public.lead_exports.next_poll_at IS 'When background processor should next check this export (null = immediate or N/A)';

-- 3. Create index for efficient background processing queries
-- This helps the cron job quickly find exports that need processing
CREATE INDEX IF NOT EXISTS idx_lead_exports_background_processing 
ON public.lead_exports (status, next_poll_at)
WHERE status IN ('building', 'building_long');

-- Verification: Check the column was added
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'lead_exports' AND column_name = 'next_poll_at';
```

### Expected Output

After successful execution, the verification query should return:

| column_name  | data_type                | is_nullable |
|--------------|--------------------------|-------------|
| next_poll_at | timestamp with time zone | YES         |

### Verification Commands

Check that the index exists:
```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'lead_exports' 
AND indexname = 'idx_lead_exports_background_processing';
```

---

## Production Migration: 004 - Polling & Compliance

**Purpose:** Adds columns for robust polling and compliance state suppression.

**SQL for Supabase SQL Editor:**

```sql
-- Migration 004: Polling & Compliance
-- Adds support for robust polling with backoff and state compliance filtering

-- 1. Add poll_attempts counter
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS poll_attempts INT DEFAULT 0;

-- 2. Add last_polled_at timestamp
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;

-- 3. Add suppressed_count for compliance filtering
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS suppressed_count INT DEFAULT 0;

-- 4. Add suppressed_states array
ALTER TABLE public.lead_exports
ADD COLUMN IF NOT EXISTS suppressed_states TEXT[];

-- Column comments
COMMENT ON COLUMN public.lead_exports.poll_attempts IS 'Number of status poll attempts made';
COMMENT ON COLUMN public.lead_exports.last_polled_at IS 'Timestamp of last poll attempt';
COMMENT ON COLUMN public.lead_exports.suppressed_count IS 'Count of leads suppressed by compliance filters';
COMMENT ON COLUMN public.lead_exports.suppressed_states IS 'States suppressed for compliance (e.g., TX)';

-- Verification
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'lead_exports' 
AND column_name IN ('poll_attempts', 'last_polled_at', 'suppressed_count', 'suppressed_states');
```

---

## Migration History

| Migration | Description | PR | Status |
|-----------|-------------|-------|--------|
| 001 | Initial schema | - | Applied |
| 002 | Add request_id | - | Applied |
| 003 | Add request_payload, requested_count | #20 | Applied |
| 004 | Add poll_attempts, last_polled_at, suppressed_count, suppressed_states | #21 | Applied |
| 005 | Add next_poll_at, background processing index | #22 | Applied |
| 006 | Lead quality + quality gate columns | #25 | Applied |

---

## Troubleshooting

### "column already exists" error
This is safe to ignore - the `IF NOT EXISTS` clause means the migration is idempotent.

### "index already exists" error
Also safe to ignore - `CREATE INDEX IF NOT EXISTS` handles this.

### Checking current schema
```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'lead_exports'
ORDER BY ordinal_position;
```

### Checking all indexes
```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'lead_exports';
```
