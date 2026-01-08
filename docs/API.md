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

**Response (Timeout - HTTP 410):**
```json
{
  "ok": false,
  "error": {
    "code": "max_poll_attempts",
    "message": "Audience build timed out after 30 poll attempts.",
    "details": {
      "audienceId": "aud-123",
      "attempts": 30,
      "maxAttempts": 30
    }
  }
}
```

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
```

## Environment Variables

Required:
- `AUDIENCELAB_API_KEY`: API key for AudienceLab
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `PASSCODE`: Session authentication passcode

Optional:
- `AUDIENCELAB_BASE_URL`: Override AudienceLab API base URL (default: `https://api.audiencelab.io`)
- `CRON_SECRET`: Secret for cron job authentication
- `CALL_SUPPRESS_STATES`: Comma-separated states to suppress for CALL exports (default: `TX`). Set to `"none"` or `""` to disable.

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
