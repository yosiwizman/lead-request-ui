# Lead Request UI - API Documentation

## Overview

This document covers the API endpoints and AudienceLab integration for the lead generation system.

## Authentication

All API endpoints require session authentication via the `PASSCODE` environment variable.
Set the `Authorization` header with the passcode value.

## Endpoints

### POST /api/leads/generate

Generate leads from AudienceLab based on intent and targeting criteria.

**Request Body:**
```json
{
  "leadRequest": "roofing repair",
  "zips": ["33101", "33130"],
  "scope": "residential",
  "useCase": "call",
  "minMatchScore": 3,
  "requestedCount": 200
}
```

**Parameters:**
- `leadRequest` (required): Intent/keywords for targeting
- `zips` (required): Array of ZIP codes for geographic targeting
- `scope` (optional): `"residential"`, `"commercial"`, or `"both"` (default: `"residential"`)
- `useCase` (optional): `"call"`, `"email"`, or `"both"` (default: `"call"`)
- `qualityTier` (optional): `"hot"`, `"balanced"`, or `"scale"` (default: `"balanced"`) - See [Lead Heat Quality Tiers](#lead-heat-quality-tiers)
- `minMatchScore` (optional): Minimum match score 0-3 (default: 3 for call, 0 for email)
- `requestedCount` (optional): Number of leads to request, 1-1000 (default: 200)

**Response (Success):**
```json
{
  "ok": true,
  "count": 150,
  "bucket": "exports",
  "path": "2026-01-08/1736345678-abc123.csv",
  "signedUrl": "https://...",
  "expiresInSeconds": 86400,
  "audienceId": "aud-123",
  "requestId": "req-abc",
  "exportId": "uuid-...",
  "quality": { ... },
  "fieldCoverage": { ... },
  "suppressedCount": 5,
  "suppressedStates": ["TX"]
}
```

**Response (Building - HTTP 202):**
```json
{
  "ok": false,
  "error": {
    "code": "provider_building",
    "message": "Audience is building. Poll /api/leads/status for results.",
    "details": {
      "audienceId": "aud-123",
      "exportId": "uuid-...",
      "retryAfterSeconds": 2
    }
  }
}
```

### POST /api/leads/status

Poll for audience build completion with exponential backoff.

**Request Body:**
```json
{
  "audienceId": "aud-123",
  "leadRequest": "roofing repair",
  "zipCodes": "33101,33130",
  "leadScope": "residential",
  "useCase": "call",
  "requestId": "req-abc",
  "exportId": "uuid-..."
}
```

**Response (Still Building - HTTP 202):**
```json
{
  "ok": false,
  "error": {
    "code": "provider_building",
    "message": "Audience is still building. Continue polling.",
    "details": {
      "audienceId": "aud-123",
      "exportId": "uuid-...",
      "pollAttempts": 3,
      "maxAttempts": 30,
      "nextPollSeconds": 8
    }
  }
}
```

**Response (Success - HTTP 200):**
```json
{
  "ok": true,
  "count": 150,
  "signedUrl": "https://...",
  "suppressedCount": 5,
  "suppressedStates": ["TX"],
  "pollAttempts": 5
}
```

**Response (Building Long - HTTP 202):**

When max poll attempts (30) are reached but the provider is still building, the export transitions to background processing:

```json
{
  "ok": false,
  "status": "building_long",
  "message": "Still building in provider. We'll keep checking in the background. You can close this page and check Export History later.",
  "exportId": "uuid-...",
  "audienceId": "aud-123",
  "pollAttempts": 30,
  "maxAttempts": 30,
  "nextPollSeconds": 300,
  "canResume": true
}
```

**Note:** HTTP 410 is never returned for long builds. The provider may still be processing, so the export is kept alive for background completion.

### GET /api/cron/process-exports (Internal)

Background processor for long-running exports. Called by Vercel Cron every 5 minutes.

**Authentication:**
Supports multiple authentication methods (in priority order):
1. `Authorization: Bearer {CRON_SECRET}` - Vercel Cron automatic behavior when `CRON_SECRET` env var is set
2. `x-cron-secret: {CRON_SECRET}` header - Legacy/manual testing
3. `?secret={CRON_SECRET}` query param - Manual curl testing

Returns 401 if secret is missing or invalid.

**Request Body (optional):**
```json
{
  "batchSize": 10,
  "dryRun": false
}
```

**Parameters:**
- `batchSize` (optional): Number of exports to process per run, 1-20 (default: 10)
- `dryRun` (optional): If true, query but don't update exports (default: false)

**Response:**
```json
{
  "ok": true,
  "processed": 3,
  "succeeded": 2,
  "failed": 0,
  "stillBuilding": 1,
  "results": [
    { "exportId": "uuid-1", "status": "success" },
    { "exportId": "uuid-2", "status": "success" },
    { "exportId": "uuid-3", "status": "building" }
  ]
}
```

**Behavior:**
1. Queries exports with status `building` or `building_long` where `next_poll_at <= now`
2. For each export: checks provider, completes if ready, schedules next poll if still building
3. Applies compliance filtering when completing exports
4. Updates `next_poll_at` to `now + 5 minutes` for still-building exports

### GET /api/debug/generation?id={exportId}

Inspect the AudienceLab request payload for debugging.

**Query Parameters:**
- `id` (required): Export UUID from the generate response

**Response:**
```json
{
  "ok": true,
  "export": {
    "id": "uuid-...",
    "request_payload": {
      "name": "Lead Request: roofing repair",
      "persona_type": "B2C",
      "size": 200,
      "filters": {
        "keywords": "roofing repair",
        "intent_strength": ["high", "medium"],
        "zip_codes": ["33101", "33130"],
        "phone_required": true,
        "dnc_status": "clean",
        "min_match_score": 3
      }
    },
    "requested_count": 200,
    "status": "success",
    "diagnostics": { ... }
  }
}
```

## AudienceLab Filter Mapping

The system builds comprehensive AudienceLab payloads based on input parameters:

### Persona Type
- `scope: "residential"` or `"both"` → `persona_type: "B2C"`
- `scope: "commercial"` → `persona_type: "B2B"`

### Intent Filters
All requests include:
- `keywords`: From `leadRequest` parameter
- `intent_strength`: `["high", "medium"]` for meaningful intent targeting

### Geographic Filters
- `zip_codes`: All provided ZIP codes
- `locations`: City/state hints for known ZIP codes (improves targeting)

### Contact Filters by Use Case

**Call Use Case (`useCase: "call"`):**
- `phone_required: true`
- `skip_trace_phone_required: true`
- `wireless_phone_required: true`
- `dnc_status: "clean"` (not on Do-Not-Call list)
- `min_match_score`: Default 3, or from `minMatchScore` parameter

**Email Use Case (`useCase: "email"`):**
- `email_required: true`
- `email_validation_status: "valid"`
- `min_match_score`: Only if explicitly provided

### Size/Count
- Default: 200 leads
- Maximum: 1000 leads
- Configured via `requestedCount` parameter

## Lead Heat Quality Tiers

The Lead Heat system optimizes lead targeting and scoring for different campaign goals. It combines vertical-specific intent packs with deterministic quality scoring.

### Quality Tier Options

| Tier | Intent Strength | Use Case | Description |
|------|-----------------|----------|-------------|
| 🔥 `hot` | High only | Dialer-first | Maximum conversion focus. High-intent signals only, strictest match accuracy. Best for live transfer and power dialing. |
| ⚖️ `balanced` | High + Medium | Default | Mix of quality and volume. Good for steady pipeline with balanced conversion rates. |
| 📈 `scale` | Medium + Low | Volume campaigns | Maximum reach. Includes broader intent signals for high-volume outreach. |

### Intent Packs

The system automatically detects vertical from `leadRequest` and applies curated high-intent keywords:

- **Remodeling**: kitchen remodel estimate, bathroom renovation contractor, home improvement, etc.
- **Roofing**: roof repair estimate, roofing contractor near me, shingle repair, etc.
- **HVAC**: ac repair near me, furnace repair estimate, hvac installation cost, etc.
- **Plumbing**: plumber near me, water heater installation, drain cleaning, etc.
- **Electrical**: electrician near me, panel upgrade cost, wiring repair, etc.
- **Home Services** (fallback): generic home repair/contractor keywords

Pack keywords are combined with the original `leadRequest` to enhance targeting without requiring users to know optimal terms.

### Quality Scoring (0-100)

Each lead receives a deterministic quality score based on contact completeness and accuracy:

**Base Score:** 50 points

**Bonuses:**
- Match score ≥7: +20 | ≥5: +15 | ≥3: +10 | ≥1: +5
- Wireless phone present: +20
- Any phone present: +10 (if no wireless)
- Full address + ZIP: +10
- City/State only: +5
- Validated email: +10
- Any email with @: +5

**Penalties:**
- No phone: -40
- Suppression flags: -25

**Score Interpretation:**
- 70+: High quality (prioritize for live transfer)
- 50-69: Medium quality (good for sequential dialing)
- <50: Low quality (high volume, lower conversion)

### CSV Export Sorting

All exports are sorted by `quality_score` descending. Highest-quality leads appear first, optimizing dialer efficiency.

### New CSV Columns (Migration 006)

The rich export schema includes:
- `quality_score`: 0-100 score
- `quality_tier`: hot/balanced/scale
- `dnc_status`: clean/flagged/unknown
- `email_validation_status`: valid/invalid/unknown

### API Request Example

```json
{
  "leadRequest": "kitchen remodeling",
  "zipCodes": "33101,33130",
  "leadScope": "residential",
  "useCase": "call",
  "qualityTier": "hot"
}
```

This request will:
1. Detect "remodeling" vertical and apply remodeling intent pack
2. Use `intent_strength: ["high"]` for maximum conversion focus
3. Score and sort leads by quality (best first)
4. Include quality metadata in CSV export

## Common Failure Modes

### Empty/Unfiltered Audiences
**Symptom:** Audience shows ~500k members, downloads return only 6-7 rows
**Cause:** Filters not being applied properly
**Debug:** Use `/api/debug/generation?id={exportId}` to inspect `request_payload.filters`

### Low Lead Counts
**Symptom:** Requested 200 leads, received fewer
**Causes:**
1. Quality filtering (DNC, match score) reduced available pool
2. Check `diagnostics.filteredDnc`, `filteredLowMatchScore` in response
3. Geographic area has limited audience

### Authentication Errors
**Error:** `AUDIENCELAB_UNAUTHORIZED`
**Causes:**
- Invalid API key
- Wrong workspace
- Revoked credentials
- Missing permissions

### Async/Building Status
**Error:** `provider_building` (HTTP 202)
**Action:** Poll `/api/leads/status` with exponential backoff:
1. Initial delay: 3 seconds
2. Backoff sequence: 3, 5, 8, 13, 21, 34, 55, 60 (capped)
3. Hard cap: 30 attempts (~25 minutes total)
4. Use `nextPollSeconds` from response for timing
5. After 30 attempts, export transitions to `building_long` for background processing

### Long-Running Builds
**Status:** `building_long` (HTTP 202)
**Behavior:** When polling exceeds 30 attempts, the export is handed off to background processing:
- Status transitions to `building_long`
- Vercel Cron checks every 5 minutes via `/api/cron/process-exports`
- Export completes automatically when provider finishes
- User can check Export History for completion
- No error is shown - the export remains active

## Database Schema

The `lead_exports` table stores metadata for each generation request:

```sql
-- Migration 003_request_payload.sql
ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS request_payload JSONB;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS requested_count INT;

COMMENT ON COLUMN lead_exports.request_payload IS 'AudienceLab request payload (sanitized, no PII)';
COMMENT ON COLUMN lead_exports.requested_count IS 'Number of leads originally requested';

-- Migration 004_polling_compliance.sql
ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS poll_attempts INT DEFAULT 0;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS suppressed_count INT DEFAULT 0;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS suppressed_states TEXT[];

COMMENT ON COLUMN lead_exports.poll_attempts IS 'Number of status poll attempts made';
COMMENT ON COLUMN lead_exports.last_polled_at IS 'Timestamp of last poll attempt';
COMMENT ON COLUMN lead_exports.suppressed_count IS 'Count of leads suppressed by compliance filters';
COMMENT ON COLUMN lead_exports.suppressed_states IS 'States suppressed for compliance';

-- Migration 005_long_build_async.sql
ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ;

COMMENT ON COLUMN lead_exports.next_poll_at IS 'Next scheduled poll time for background processing';

CREATE INDEX IF NOT EXISTS idx_lead_exports_background_processing
ON lead_exports (status, next_poll_at)
WHERE status IN ('building', 'building_long');

-- Migration 006_lead_quality.sql
ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS quality_tier TEXT;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS intent_pack TEXT;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS avg_quality_score DECIMAL(5,2);

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS max_quality_score INT;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS high_quality_count INT DEFAULT 0;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS medium_quality_count INT DEFAULT 0;

ALTER TABLE lead_exports
ADD COLUMN IF NOT EXISTS low_quality_count INT DEFAULT 0;

COMMENT ON COLUMN lead_exports.quality_tier IS 'Quality tier used: hot, balanced, scale';
COMMENT ON COLUMN lead_exports.intent_pack IS 'Intent pack ID applied (remodeling, roofing, etc.)';
COMMENT ON COLUMN lead_exports.avg_quality_score IS 'Average quality score of exported leads';
COMMENT ON COLUMN lead_exports.max_quality_score IS 'Maximum quality score in export';
COMMENT ON COLUMN lead_exports.high_quality_count IS 'Count of leads with score >= 70';
COMMENT ON COLUMN lead_exports.medium_quality_count IS 'Count of leads with score 50-69';
COMMENT ON COLUMN lead_exports.low_quality_count IS 'Count of leads with score < 50';
```

## Environment Variables

Required:
- `AUDIENCELAB_API_KEY`: API key for AudienceLab
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `PASSCODE`: Session authentication passcode

Optional:
- `AUDIENCELAB_BASE_URL`: Override AudienceLab API base URL (default: `https://api.audiencelab.io`)
- `CRON_SECRET`: Secret for cron job authentication (required for background export processing). When set in Vercel, Vercel Cron automatically sends this as `Authorization: Bearer {CRON_SECRET}`.
- `CALL_SUPPRESS_STATES`: Comma-separated states to suppress for CALL exports (default: `TX`). Set to `"none"` or `""` to disable.
- `BACKGROUND_POLL_MINUTES`: Interval for background export processing (default: 5)
- `BACKGROUND_BATCH_SIZE`: Number of exports to process per cron run (default: 10, max: 20)

## Cron Jobs

The system uses Vercel Cron Jobs for background processing.

### Endpoints

| Endpoint | Schedule | Purpose |
|----------|----------|----------|
| `/api/cron/cleanup` | Daily | Remove expired exports (30+ days old) |
| `/api/cron/process-exports` | Every 5 min | Complete long-running audience builds |

### Authentication

Vercel Cron Jobs automatically authenticate when `CRON_SECRET` is set as an environment variable. Vercel sends the secret as:
```
Authorization: Bearer {CRON_SECRET}
```

For manual testing, you can also use:
```bash
# x-cron-secret header
curl -H "x-cron-secret: YOUR_SECRET" https://your-app.vercel.app/api/cron/cleanup

# query param (less secure, use for local testing only)
curl "https://your-app.vercel.app/api/cron/cleanup?secret=YOUR_SECRET"
```

### Configuration

Cron schedules are defined in `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/cleanup", "schedule": "0 3 * * *" },
    { "path": "/api/cron/process-exports", "schedule": "*/5 * * * *" }
  ]
}
```

### Why HTTP 410 Is Not Used for Long Builds

HTTP 410 (Gone) indicates a resource has been **permanently deleted** and will never be available again. This is semantically incorrect for audience builds that are still processing - the export is not gone, it's just taking longer than expected.

Instead, long builds return HTTP 202 (Accepted) with `status: 'building_long'`, indicating the request is still being processed in the background.

## Compliance: State Suppression

For `useCase: "call"` exports, leads from certain states are automatically suppressed:

### Default Behavior
- Texas (TX) is suppressed by default due to strict telemarketing regulations
- Suppression only applies to CALL useCase; email exports are not affected

### Configuration
```bash
# Default: suppress Texas
CALL_SUPPRESS_STATES=TX

# Suppress multiple states
CALL_SUPPRESS_STATES=TX,CA,NY

# Disable suppression entirely
CALL_SUPPRESS_STATES=none
CALL_SUPPRESS_STATES=""
```

### Response Fields
When suppression occurs, responses include:
- `suppressedCount`: Number of leads removed
- `suppressedStates`: Array of states that were suppressed (e.g., `["TX"]`)

### Important Disclaimer
**State suppression is a technical guardrail only.** Users remain responsible for compliance with all applicable telemarketing laws and regulations including:
- Telephone Consumer Protection Act (TCPA)
- State Do-Not-Call (DNC) lists
- Time-of-day calling restrictions
- Industry-specific regulations
