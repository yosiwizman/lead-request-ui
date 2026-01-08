# Operations & Security Notes

## Supabase Storage

### `exports` bucket
- Visibility: PRIVATE (not public)
- Purpose: Stores generated lead CSV files
- Access: Server-side only via service role key
- Files are accessed via signed URLs with expiration

## Environment Variables

### Server-only (NOT exposed to client)
| Variable | Description |
|----------|-------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Full access key for server-side operations. Lives only in Vercel env vars. |
| `SUPABASE_URL` | Optional server-only project URL; preferred on server if set. |
| `LEAD_PROVIDER` | Provider selection: `mock` (default) or `audiencelab`. |
| `AUDIENCELAB_API_KEY` | AudienceLab API key. Required when `LEAD_PROVIDER=audiencelab`. |
| `AUDIENCELAB_BASE_URL` | Optional AudienceLab API base URL. Defaults to `https://api.audiencelab.io`. |

### Client-safe (exposed to browser)
| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL (used on client, and as server fallback) |
| `VITE_SUPABASE_ANON_KEY` | Public/anon key for client-side auth |

### Server Env Fallback
- Server reads Supabase URL with fallback: `SUPABASE_URL || VITE_SUPABASE_URL`
- Service role key: `SUPABASE_SERVICE_ROLE_KEY` (never exposed to the client)

## Security Rules

1. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the frontend
   - Do not prefix with `VITE_`
   - Only use in API routes / Edge Functions

2. Always use signed URLs for private bucket access
   - Generate signed URLs server-side
   - Expiration is set to 24 hours (86,400 seconds)

3. Validate requests server-side
   - Don't trust client-provided file paths
   - Sanitize filenames before storage

---

## API Endpoint Contract

### POST /api/leads/generate

- Request JSON:
  { "leadRequest": "string", "zipCodes": "string", "leadScope": "residential|commercial|both", "useCase": "call|email|both", "minMatchScore": 0-3 }
- Validation:
  - `leadRequest` required, 3–200 chars
  - `zipCodes` parsed by comma/space; each ZIP must be 5 digits; 1–200 zips
  - `leadScope` required: `residential` | `commercial` | `both`
  - `useCase` optional (defaults to `both`): `call` | `email` | `both`
  - `minMatchScore` optional (defaults to 3 for `call`, 0 for others): 0-3

**Quality Preset (useCase) Behavior:**
- `call`: Requires phone present; excludes DNC-flagged contacts (B2C only); filters by minMatchScore (default: 3)
- `email`: Requires Valid(Esp) email + LAST_SEEN within 30 days
- `both`: Either phone or email required; excludes DNC-flagged contacts (B2C only)

**minMatchScore Parameter:**
For Call Leads, filters contacts by match accuracy score:
- `3` (default): High tier only (ADDRESS+EMAIL match) — Best for dialer campaigns
- `2`: Medium tier and above (NAME+ADDRESS match)
- `1`: Low tier and above (any match method)
- `0`: No filtering by match score

**Responses:**
- **200 OK** (immediate success):
  { "ok": true, "count": number, "bucket": "exports", "path": "...", "signedUrl": "string", "expiresInSeconds": 86400, "audienceId": "string", "requestId": "string", "quality": {...} }
- **202 Accepted** (audience building async):
  { "ok": false, "error": { "code": "provider_building", "message": "...", "details": { "audienceId": "...", "leadRequest": "...", "zipCodes": "...", "leadScope": "...", "useCase": "...", "requestId": "...", "retryAfterSeconds": 2 } } }
- **404 Not Found** (no results after building complete):
  { "ok": false, "error": { "code": "provider_no_results", "message": "...", "details": {...} } }
- **4xx/5xx** (other errors): Standard error shape.

### POST /api/leads/status (Polling Endpoint)

Used to poll for results after generate returns 202.

- Request JSON:
  { "audienceId": "string", "leadRequest": "string", "zipCodes": "string", "leadScope": "string", "useCase": "string", "requestId": "string" }
- **200 OK**: Success with signedUrl and quality summary (same as generate success).
- **202 Accepted**: Still building. Client should poll again.
- **404 Not Found**: Definitively no results.

The status endpoint polls internally with backoff (up to 3 attempts, ~6s max) before returning.

### Client-Side Polling Flow

1. Call `POST /api/leads/generate`
2. If 200: Success, show download link.
3. If 202: Start polling `/api/leads/status` every 2 seconds.
4. Continue polling until:
   - 200 (success) → show download link
   - 404 (no results) → show error + audienceId
   - 60s timeout → show "still building" message + audienceId

- Standard error shape:
  { "ok": false, "error": { "code": "string", "message": "string", "details": { "...": "..." } } }

## Signed URL Behavior

- Files uploaded to the PRIVATE `exports` bucket.
- Signed URLs are generated server-side and returned to the client.
- Default expiration: 24 hours (86,400 seconds).
- Clients should download promptly; URLs expire and cannot be refreshed without a new request.

## Vercel Bundling

- Vercel serverless functions can only import from within the `api/` directory tree.
- Shared logic (types, validation, CSV, providers) lives in `api/_lib/`.
- Do NOT import from `src/` in API routes; Vercel will fail to bundle those imports.
- Structure:
  - `api/_lib/types.ts` - Shared types (Lead, LeadScope, etc.)
  - `api/_lib/validation.ts` - Payload validation
  - `api/_lib/csv.ts` - CSV generation
  - `api/_lib/providers/mock.ts` - Mock lead provider
  - `api/_lib/providers/audiencelab.ts` - AudienceLab lead provider
  - `api/_lib/json.ts` - JSON response helpers

## Provider Abstraction

- Provider selection via `LEAD_PROVIDER` env var: `mock` (default) or `audiencelab`.
- Interface: `generateLeads({ leadRequest, zips, scope }) -> Promise<ProviderResult>`
- ProviderResult: `{ ok: true, leads: Lead[], audienceId?, requestId?, diagnostics? }` or `{ ok: false, error: ProviderError }`
- **NO silent fallback:** When `LEAD_PROVIDER=audiencelab` but `AUDIENCELAB_API_KEY` is missing, returns HTTP 500 `server_config_error` (not silent mock fallback).
- Provider errors map to appropriate HTTP status codes.

## Lead Quality Field Strategy

Based on AudienceLab Fields Guide for high-quality lead data:

### B2B (Commercial Scope)
- **Email**: `BUSINESS_EMAIL` (only if `BUSINESS_EMAIL_VALIDATION_STATUS` = Valid when field exists)
- **Phone**: `SKIPTRACE_B2B_WIRELESS` > `SKIPTRACE_B2B_LANDLINE` > `mobile_phone` > `phone`
- **Address**: `COMPANY_ADDRESS` preferred, fallback to `address`

### B2C (Residential Scope)
- **Email**: `PERSONAL_EMAIL` (only if `PERSONAL_EMAIL_VALIDATION_STATUS` = Valid when field exists)
- **Phone**: `SKIPTRACE_WIRELESS_NUMBERS` > `SKIPTRACE_LANDLINE_NUMBERS` > `mobile_phone` > `phone`
- **DNC Filter**: Exclude contacts where `DNC` = "Y"

## Field Mapping Sources

AudienceLab returns data in various field locations. The mapping prioritizes **SKIPTRACE_*** (offline/verified) fields for outbound use cases.

### Field Accessor

The `getField()` function reads fields from multiple locations:
1. Root level: `contact.FIELD_NAME`
2. Nested `fields`: `contact.fields.FIELD_NAME`
3. Nested `data`: `contact.data.FIELD_NAME`
4. Nested `profile`: `contact.profile.FIELD_NAME`

This handles various AudienceLab response shapes without code changes.

### Name Mapping Priority

1. `SKIPTRACE_NAME` (full name, parsed into first/last)
2. `SKIPTRACE_FIRST_NAME` + `SKIPTRACE_LAST_NAME`
3. `FIRST_NAME` + `LAST_NAME` (uppercase variants)
4. `first_name` + `last_name` (lowercase variants)

**Name Parsing:** If `SKIPTRACE_NAME` contains a full name like "John Michael Doe", it's split: last token → `last_name`, remainder → `first_name`.

### Address Mapping Priority

**B2C:**
1. `SKIPTRACE_ADDRESS` / `SKIPTRACE_CITY` / `SKIPTRACE_STATE` / `SKIPTRACE_ZIP`
2. `address` / `city` / `state` / `zip`
3. `street_address` / `postal_code` (fallbacks)

**B2B:**
1. `SKIPTRACE_ADDRESS` (if available)
2. `COMPANY_ADDRESS`
3. `address` / `street_address`

### Phone Mapping Priority

**B2C:**
1. `SKIPTRACE_WIRELESS_NUMBERS`
2. `SKIPTRACE_LANDLINE_NUMBERS`
3. `mobile_phone`
4. `phone`

**B2B:**
1. `SKIPTRACE_B2B_WIRELESS` / `SKIPTRACE_B2B_WIRELESS_PHONE`
2. `SKIPTRACE_B2B_LANDLINE` / `SKIPTRACE_B2B_LANDLINE_PHONE`
3. `mobile_phone`
4. `phone`

**Phone Normalization:** Phone fields may contain comma/pipe-separated lists. The first valid 10-11 digit number is extracted and normalized to E.164 format (`+1XXXXXXXXXX`).

### Troubleshooting: 0% Field Coverage

**Symptom:** Field Coverage Diagnostics shows 0% for name/address/email despite phone coverage being high.

**Likely Cause:** The AudienceLab audience/tier does not include skiptrace or offline fields for that query.

**Resolution:**
1. Check the raw response shape using the `requestId` in logs
2. Verify the audience includes skiptrace fields in AudienceLab dashboard
3. Consider using a different audience tier or match_by configuration
4. Contact AudienceLab support if fields should be present but aren't

**Note:** Some audience tiers only include phone numbers without identity data. This is expected for certain data sources.

## Recipe Engine

The Recipe Engine applies preset-specific rules to maximize lead quality based on AudienceLab's documented field best practices.

### Recipe Rules by Preset

**Call Preset:**
- Requires phone present
- Excludes DNC-flagged contacts (B2C/residential only; B2B ignores DNC)
- Filters by `minMatchScore` (default: 3 = high tier only)
- No freshness requirement

**Email Preset:**
- Requires email with `Valid (Esp)` validation status (highest email deliverability)
- Requires `LAST_SEEN` within 30 days (freshness window)
- Contacts with `LAST_SEEN` > 30 days are excluded as `email_too_old`
- Contacts without `LAST_SEEN` field pass (field may not be populated)

**Both Preset:**
- Either phone or email required
- Excludes DNC-flagged contacts (B2C only)
- No freshness requirement

### Accuracy Tier Ranking & Numeric Match Score

The recipe engine evaluates contact accuracy using `SKIPTRACE_MATCH_BY` (B2C) or `SKIPTRACE_B2B_MATCH_BY` (B2B) and assigns both a tier and numeric score:

**High Tier (Score 3):** ADDRESS + EMAIL match
- Most accurate; address and email both confirmed

**Medium Tier (Score 2):** NAME + ADDRESS match
- Good accuracy; name and address confirmed

**Low Tier (Score 1):** Other match methods
- PHONE, NAME only, or other match methods

**No Match Data (Score 0):** No SKIPTRACE_MATCH_BY field
- Unknown accuracy; proceed with caution

For Call Leads, the `minMatchScore` filter is applied (default: 3). Contacts scoring below the threshold are excluded with `filteredLowMatchScore` tracked in diagnostics.

Leads are sorted by tier (high → medium → low) before applying the 50-lead cap, ensuring the highest-quality leads are prioritized.

### Match Tier Display

The UI displays tier breakdown in the Quality Summary:
- `High: N` — Leads matched by ADDRESS + EMAIL
- `Medium: N` — Leads matched by NAME + ADDRESS
- `Low: N` — Leads matched by other methods

This helps users understand the accuracy distribution of their leads without exposing PII.

### Quality Summary Response

Each successful response (200 OK) includes a `quality` object with filtering metrics:
```json
{
  "quality": {
    "totalFetched": 50,
    "kept": 35,
    "filteredMissingPhone": 8,
    "filteredInvalidEmail": 3,
    "filteredInvalidEmailEsp": 2,
    "filteredEmailTooOld": 1,
    "filteredDnc": 2,
    "filteredLowMatchScore": 5,
    "missingNameOrAddressCount": 5,
    "matchByTier": { "high": 20, "medium": 10, "low": 5 },
    "matchScoreDistribution": { "score0": 2, "score1": 10, "score2": 18, "score3": 20 }
  }
}
```

**Field Descriptions:**
- `totalFetched`: Raw contacts retrieved from AudienceLab
- `kept`: Contacts included in the final CSV export
- `filteredMissingPhone`: Excluded due to missing phone (applies to `useCase=call`)
- `filteredInvalidEmail`: Excluded due to missing/invalid email
- `filteredInvalidEmailEsp`: Excluded due to email not being Valid(Esp) (applies to `useCase=email`)
- `filteredEmailTooOld`: Excluded due to LAST_SEEN > 30 days (applies to `useCase=email`)
- `filteredDnc`: Excluded due to DNC (Do Not Call) flag (B2C only)
- `filteredLowMatchScore`: Excluded due to match score below `minMatchScore` threshold (applies to `useCase=call`)
- `missingNameOrAddressCount`: Kept contacts that are missing name or address (informational)
- `matchByTier`: Breakdown of kept leads by accuracy tier (high/medium/low)
- `matchScoreDistribution`: Distribution of ALL fetched contacts by score (before filtering)

### Field Coverage Diagnostics

Each successful response (200 OK) also includes a `fieldCoverage` object that reports field presence statistics BEFORE and AFTER filtering. This helps diagnose data quality issues and determine if enrichment is needed.

```json
{
  "fieldCoverage": {
    "coverageFetched": {
      "total": 50,
      "present": {
        "first_name": 45,
        "last_name": 43,
        "address": 12,
        "city": 48,
        "state": 50,
        "zip": 50,
        "phone": 50,
        "email": 8
      },
      "pct": {
        "first_name": 90,
        "last_name": 86,
        "address": 24,
        "city": 96,
        "state": 100,
        "zip": 100,
        "phone": 100,
        "email": 16
      }
    },
    "coverageKept": {
      "total": 35,
      "present": { ... },
      "pct": { ... }
    }
  }
}
```

**Coverage Blocks:**
- `coverageFetched`: Field coverage of raw contacts BEFORE quality filtering
- `coverageKept`: Field coverage of kept leads AFTER quality filtering

**Fields Tracked:** `first_name`, `last_name`, `address`, `city`, `state`, `zip`, `phone`, `email`

**Coverage Structure:**
- `total`: Number of contacts/leads in this set
- `present`: Count of non-empty values for each field
- `pct`: Percentage (0-100) of contacts with each field present

**NO PII:** Coverage only reports counts and percentages—never actual field values.

#### Interpreting Field Coverage

**Healthy coverage:**
- Phone/Email: >80% is good for call/email campaigns
- Name: >70% enables personalization
- Address: >50% supports direct mail

**Low coverage indicators:**
- 0-5%: Field is effectively absent for this audience
- 5-25%: Very sparse; consider enrichment
- 25-50%: Partial coverage; evaluate business impact

#### Enrichment Decision Rules

The UI shows an enrichment warning when ANY of these conditions are true in `coverageFetched`:
- `pct.first_name` ≤ 5%
- `pct.address` ≤ 5%
- `pct.email` ≤ 5%

**When to enrich:**
1. If phone-only leads are common (phone coverage high, everything else low)
2. If name/address coverage is insufficient for your campaign type
3. If email coverage is needed but currently sparse

**Enrichment options:**
- Data append services (e.g., FullContact, Clearbit)
- Skip tracing services for phone → name/address lookup
- Email discovery services

### CSV Export Columns

The CSV export includes the following columns:

**Core Lead Fields:**
- `first_name`, `last_name`: Contact name
- `address`, `city`, `state`, `zip`: Address information
- `phone`: Best available phone number (E.164 format: +1XXXXXXXXXX)
- `email`: Best available email
- `lead_type`: `residential` or `commercial`
- `tags`: Lead request/query string
- `source`: Data source (`audiencelab` or `mock`)

**Dialer-Friendly Phone Columns (NEW):**
- `best_phone`: Same as `phone`, for dialer convenience
- `phones_all`: All available phone numbers (pipe-separated, e.g., `+13055551234|+13055552222`)
- `wireless_phones`: Wireless/mobile phones only (pipe-separated)
- `landline_phones`: Landline phones only (pipe-separated)

**Quality Column (NEW):**
- `match_score`: Numeric quality score (0-3)
  - `3`: High accuracy (ADDRESS+EMAIL match)
  - `2`: Medium accuracy (NAME+ADDRESS match)
  - `1`: Low accuracy (other match methods)
  - `0` or empty: No match data available

### CSV Security

**Formula injection prevention:** All CSV values starting with `=`, `+`, `-`, `@`, tab, or carriage return are prefixed with a single quote (`'`) to prevent spreadsheet formula execution.

### Mock Provider (`api/_lib/providers/mock.ts`)
- Deterministic 50 mock leads based on input hash.
- Always returns `ok: true`.
- Source field: `mock`.

### AudienceLab Provider (`api/_lib/providers/audiencelab.ts`)
- Creates audience via AudienceLab API, then fetches audience members.
- Requires `AUDIENCELAB_API_KEY` env var with **WRITE permission**.
- Uses ZIP code lookup to enhance geographic targeting.
- Maps AudienceLab contact fields to Lead schema.
- Throws typed errors: `AudienceLabAuthError` (401/403), `AudienceLabUpstreamError` (5xx), `AudienceLabContractError` (response shape mismatch).
- Uses robust ID extraction (`api/_lib/audiencelab-response.ts`) to handle various response shapes.
- Returns `provider_error` on other API failures, `provider_no_results` on empty results.
- Source field: `audiencelab`.
- Caps results at 50 leads per request.
- Includes `requestId` in all error responses for log correlation.

### Error Mapping
- `AUDIENCELAB_UNAUTHORIZED` → HTTP 502 (auth failure, includes hint)
- `AUDIENCELAB_UPSTREAM_ERROR` → HTTP 502 (service error)
- `AUDIENCELAB_NO_AUDIENCE_ID` → HTTP 502 (response contract mismatch)
- `AUDIENCELAB_ERROR_PAYLOAD` → HTTP 502 (200 response with error body)
- `AUDIENCELAB_ASYNC_RESPONSE` → HTTP 502 (job/async response)
- `provider_error` → HTTP 502 (Bad Gateway)
- `provider_no_results` → HTTP 404 (Not Found)

## AudienceLab API Key Management

### Creating/Rotating the Key
1. Log in to AudienceLab dashboard
2. Navigate to Settings → API Keys
3. Create a new key with **WRITE** permission (required for audience creation)
4. Copy the key immediately (it won't be shown again)
5. Update `AUDIENCELAB_API_KEY` in Vercel env vars (see below)
6. Delete the old key if rotating

### Smoke Test
Verify the key is valid before deploying:
```bash
# Local verification
AUDIENCELAB_API_KEY=your_key pnpm smoke:audiencelab

# Or if env var is already set
pnpm smoke:audiencelab
```
The smoke test calls `GET /audiences?page=1&page_size=1` and reports:
- ✅ Success: key is valid
- ❌ 401/403: auth failure with resolution steps
- Key is masked in output (shows only first/last 4 chars)

### Vercel Env Var Rotation
1. Go to Vercel project → Settings → Environment Variables
2. Find `AUDIENCELAB_API_KEY`
3. Click Edit → paste new key → mark as Sensitive → Save
4. Update for **both** Preview and Production environments
5. Trigger a redeploy: Deployments → ... → Redeploy
6. Verify with smoke test against deployed endpoint

### Security Notes
- **Never** paste API keys into GitHub issues, PRs, or commit messages
- **Never** log or display the full API key; use masking (first/last 4 chars)
- Keys should only be entered into:
  - Vercel env vars (via dashboard, marked Sensitive)
  - Local terminal for smoke testing
  - `.env.local` (gitignored) for local dev
- Typed errors (`AudienceLabAuthError`) never include the key in message or context

### Troubleshooting: Filtered Leads (Few Results)

**Symptom:**
User sees fewer leads than expected in the Quality Summary.

**Cause:**
The `useCase` filter is removing contacts that don't meet the criteria:
- `call`: Contacts without phone are filtered
- `email`: Contacts without validated email are filtered
- DNC-flagged contacts are always filtered for B2C

**Resolution:**
1. Check the Quality Summary breakdown to see why leads were filtered
2. Try a different `useCase` preset:
   - Use "Call + Email (Best available)" for maximum results
   - Use "Call Leads" only when phone is essential
   - Use "Email Leads" only when validated email is essential
3. If `filteredDnc` is high, consider switching to Commercial (B2B) target
4. If `missingNameOrAddressCount` is high, the data quality from AudienceLab may be limited for that query

### Troubleshooting: Audience Building (202)

**Symptom:**
API returns HTTP 202 with `provider_building` error code.

**Cause:**
AudienceLab audiences take time to populate. The audience was created successfully but has no members yet.

**Expected Behavior:**
1. UI shows "Building audience..." with elapsed time.
2. UI polls `/api/leads/status` every 2 seconds.
3. After up to 60 seconds, either success or timeout message.

**Resolution:**
- Most audiences populate within 5-30 seconds.
- If consistently empty after 60s, contact AudienceLab support with the `audienceId`.
- Check AudienceLab dashboard to verify the audience was created.

### Troubleshooting: server_config_error (500)

**Symptom:**
API returns HTTP 500 with `server_config_error` code.

**Cause:**
Missing required environment variable(s). Common cases:
- `LEAD_PROVIDER=audiencelab` but `AUDIENCELAB_API_KEY` is missing.
- `SUPABASE_URL` and `VITE_SUPABASE_URL` both missing.
- `SUPABASE_SERVICE_ROLE_KEY` missing.

**Resolution:**
1. Check error `details` and `hint` for specific missing variable.
2. Go to Vercel project → Settings → Environment Variables.
3. Add/fix the missing variable.
4. Redeploy.

### Troubleshooting: ByteString / BOM Errors

**Symptom:**
```
Cannot convert argument to a ByteString because the character at index 0 has a value of 65279 which is greater than 255
```

**Cause:**
The `AUDIENCELAB_API_KEY` env var contains an invisible UTF-8 BOM (Byte Order Mark, U+FEFF = 65279) at the beginning. This often happens when:
- Copying from rich text editors (Word, Google Docs, Notion)
- Copying from certain password managers
- File encoding issues

**Fix:**
1. Go to Vercel project → Settings → Environment Variables
2. Delete the existing `AUDIENCELAB_API_KEY`
3. Re-copy the key **directly** from AudienceLab dashboard (plain text source)
4. Paste into Vercel and save
5. Redeploy

**Prevention:**
Our codebase now includes a `sanitizeByteString()` utility (`api/_lib/bytestring.ts`) that:
- Strips leading BOM characters automatically
- Validates all characters are Latin1 (charCode ≤ 255)
- Returns a clean `ConfigError` with actionable hints instead of crashing

If you see a `CONFIG_MISSING`, `CONFIG_EMPTY`, or `INVALID_HEADER_VALUE` error in the JSON response, check the `hint` field for resolution steps.

### Troubleshooting: No Audience ID Returned

**Symptom:**
```
AudienceLab did not return an audience ID
```
or error code `AUDIENCELAB_NO_AUDIENCE_ID` in the JSON response.

**Cause:**
The AudienceLab API returned a 200 response, but the response body doesn't contain an audience ID in any of the expected locations.

**What we check:**
- Root level: `id`, `audience_id`, `audienceId`
- Nested: `data.id`, `audience.id`, `result.id`
- Array: `[0].id`, `data[0].id`
- Location header: `/audiences/<id>`

**Using the requestId:**
Every error response includes a `requestId` field (e.g., `req_abc123_xyz`). Use this to:
1. Find related logs in Vercel: Deployments → View Function Logs → search for the requestId
2. Report to AudienceLab support with the requestId for correlation

**Response shape in logs:**
The `responseShape` field shows the sanitized structure of the response (key names only, no values). Example:
```
object{status,message,data:object{name,created_at}}
```
This helps diagnose contract mismatches without exposing sensitive data.

**Resolution:**
1. Check if AudienceLab API documentation has changed
2. Contact AudienceLab support with the requestId
3. If the response shape shows `job_id` or `task_id`, the API may be returning async results (error code will be `AUDIENCELAB_ASYNC_RESPONSE`)

### Troubleshooting: 200 Response with Error

**Symptom:**
Error code `AUDIENCELAB_ERROR_PAYLOAD` with an `upstreamMessage` field.

**Cause:**
The AudienceLab API returned HTTP 200 but the body contains an error indicator:
- `{ error: "..." }`
- `{ errors: [...] }`
- `{ success: false, message: "..." }`

**Resolution:**
The `upstreamMessage` field contains the error from AudienceLab. Common causes:
- Rate limiting
- Invalid request parameters
- Account/workspace issues

## Rationale: Service Role Key Stays Server-only

- The service role key grants full access to Storage and Database.
- Exposing it to the client would allow unrestricted file operations.
- Therefore, it must be used only in serverless functions (Vercel) or Edge Functions and never bundled into client code.

---

## App-Level Access Control (Authentication)

### Overview

The app uses passcode-based authentication with httpOnly session cookies to prevent unauthorized access to lead generation. This is NOT user authentication—it's app-level access control.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `APP_PASSCODE` | The passcode required to access the app. Required in production. |
| `SESSION_SECRET` | Secret key for signing session tokens. Must be 32+ characters. Required in production. |
| `SESSION_TTL_SECONDS` | Session duration in seconds. Default: 604800 (7 days). |
| `AUTH_DISABLED_FOR_TESTS` | Set to `true` to bypass auth (tests only). |

### How It Works

1. User visits the app → frontend calls `GET /api/auth/me`
2. If 401, show login screen
3. User enters passcode → `POST /api/auth/login { passcode }`
4. If correct, server sets httpOnly cookie `lr_session` with signed token
5. All protected routes (`/api/leads/*`, `/api/exports/*`) validate the cookie

### Security Properties

- **httpOnly cookie**: JavaScript cannot read the session token
- **Secure flag**: Cookie only sent over HTTPS in production
- **SameSite=Strict**: Prevents CSRF attacks
- **HMAC-SHA256 signature**: Token cannot be forged without SESSION_SECRET
- **Server-side TTL check**: Expired tokens are rejected

### API Endpoints

#### POST /api/auth/login
- Request: `{ "passcode": "string" }`
- 200 OK: `{ "ok": true }` + sets `lr_session` cookie
- 401 Unauthorized: `{ "ok": false, "error": "Invalid passcode" }`

#### GET /api/auth/me
- No body required (reads cookie)
- 200 OK: `{ "ok": true }` (session valid)
- 401 Unauthorized: `{ "ok": false, "error": "Not authenticated" }`

### Protected Routes

All of these require valid session:
- `POST /api/leads/generate`
- `POST /api/leads/status`
- `GET /api/exports/list`
- `POST /api/exports/signed-url`

---

## Export History (Postgres)

### Overview

Export metadata is persisted in Supabase Postgres for tracking and re-downloading old exports. **Only metadata is stored—no PII.**

### Database Migration

Run the migration in `supabase/migrations/001_lead_exports.sql`:

```sql
-- Run in Supabase SQL Editor or via supabase CLI
-- Creates lead_exports table with RLS disabled (server-only access)
```

### Table Schema: `lead_exports`

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `created_at` | timestamptz | When export started |
| `updated_at` | timestamptz | Last status update |
| `provider` | text | `mock` or `audiencelab` |
| `lead_request` | text | The query string |
| `zip_codes` | text[] | Array of ZIP codes |
| `target` | text | Target scope |
| `use_case` | text | Quality preset |
| `audience_id` | text | AudienceLab audience ID (if available) |
| `request_id` | text | Internal request ID for logs |
| `status` | text | `building`, `success`, `no_results`, `error` |
| `error_code` | text | Error code if failed |
| `error_message` | text | Error message if failed |
| `total_fetched` | integer | Raw contacts fetched |
| `kept` | integer | Leads after filtering |
| `diagnostics` | jsonb | Quality diagnostics |
| `field_coverage` | jsonb | Field coverage stats |
| `bucket` | text | Storage bucket name |
| `path` | text | File path in bucket |
| `last_signed_url_at` | timestamptz | Last time download link was generated |

### API Endpoints

#### GET /api/exports/list
- Session required
- Query params: `?limit=N` (default 25, max 100)
- 200 OK: `{ "ok": true, "exports": [...], "total": N }`

#### POST /api/exports/signed-url
- Session required
- Request: `{ "exportId": "uuid" }`
- 200 OK: `{ "ok": true, "signedUrl": "...", "expiresIn": 3600 }`
- 404: Export not found or no file
- 400: Export not in success status

### How Exports Are Tracked

1. `POST /api/leads/generate` creates a row with `status=building`
2. On success: updates with `status=success`, counts, diagnostics, file path
3. On error: updates with `status=error`, error code/message
4. For async (202): stores `audience_id` for later lookup
5. `POST /api/leads/status` finds export by `audience_id` and updates on completion

### Regenerating Download Links

- Signed URLs expire (default 1 hour for regenerated links)
- Users can click "Get Download Link" in Export History to regenerate
- File must still exist in storage (not deleted)
- Only `success` status exports have downloadable files

---

## Go-Live Checklist

Use this checklist when deploying auth + export history features to production.

### 1. Vercel Environment Variables

Set these in Vercel Dashboard → Project Settings → Environment Variables.
Apply to **both Production and Preview** environments.

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_PASSCODE` | Yes | Passcode for app access. 15+ chars recommended. |
| `SESSION_SECRET` | Yes | Secret for token signing. 32+ chars, high entropy. |
| `SESSION_TTL_SECONDS` | No | Session duration. Default: 604800 (7 days). |

**Important:** After adding/changing env vars, trigger a new deployment:
- Go to Deployments → latest → ... → Redeploy
- Or push a commit to trigger CI

### 2. Supabase Database Migration

Run the migration to create the `lead_exports` table:

**File:** `supabase/migrations/001_lead_exports.sql`

**How to apply:**
1. Open Supabase Dashboard → SQL Editor
2. Copy the entire contents of the migration file
3. Paste and click "Run"
4. Verify table exists: `SELECT * FROM lead_exports LIMIT 1;`

**What it creates:**
- `lead_exports` table for export history metadata (no PII)
- Indexes for efficient listing and lookup
- Auto-update trigger for `updated_at` timestamp

### 3. Verification Steps

After both steps are complete:

1. **Login works:** Visit prod → should show passcode prompt → enter passcode → main app loads
2. **Generate works:** Generate leads → should succeed and show download link
3. **Export History works:** Click "Export History" → should list recent exports
4. **Link regeneration works:** Click "Get Download Link" on a past export → should open CSV

### Troubleshooting: Go-Live Issues

**Symptom: Login page but passcode doesn't work**
- Cause: `APP_PASSCODE` not set or wrong value
- Fix: Check Vercel env vars, redeploy

**Symptom: Login works but generate fails with 500**
- Cause: `SESSION_SECRET` not set
- Fix: Set SESSION_SECRET (32+ chars), redeploy

**Symptom: Export History shows empty or errors**
- Cause: Migration not applied
- Fix: Run `001_lead_exports.sql` in Supabase SQL Editor

**Symptom: "Supabase not configured" errors in logs**
- Cause: Missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`
- Fix: These should already be set from initial setup; verify in Vercel env vars

**Symptom: Blank white page after login (React Error #31)**
- Cause: UI tries to render an error object directly as a React child
- This is fixed in v1.1.0+ with the `getErrorMessage()` helper and ErrorBoundary
- If you see this on older versions, update to latest main
- Console will show: `Objects are not valid as a React child (object with keys {code, message})`

**Symptom: Login returns 500 Internal Server Error**
- Cause: `APP_PASSCODE` env var is missing or contains invisible characters (BOM)
- Fix:
  1. Go to Vercel → Environment Variables
  2. Delete `APP_PASSCODE`
  3. Re-add it by typing (not pasting) or paste from a plain text source
  4. Redeploy
- To verify, check Vercel function logs for error details
