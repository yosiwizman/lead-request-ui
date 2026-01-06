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
  { "leadRequest": "string", "zipCodes": "string", "leadScope": "residential|commercial|both", "useCase": "call|email|both" }
- Validation:
  - `leadRequest` required, 3–200 chars
  - `zipCodes` parsed by comma/space; each ZIP must be 5 digits; 1–200 zips
  - `leadScope` required: `residential` | `commercial` | `both`
  - `useCase` optional (defaults to `both`): `call` | `email` | `both`

**Quality Preset (useCase) Behavior:**
- `call`: Requires phone present; contacts without phone are filtered out
- `email`: Requires validated email present; contacts without valid email are filtered out
- `both`: Either phone or email required (default, most permissive)

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

### Quality Summary Response

Each successful response (200 OK) includes a `quality` object with filtering metrics:
```json
{
  "quality": {
    "totalFetched": 50,
    "kept": 35,
    "filteredMissingPhone": 8,
    "filteredInvalidEmail": 3,
    "filteredDnc": 2,
    "missingNameOrAddressCount": 5
  }
}
```

**Field Descriptions:**
- `totalFetched`: Raw contacts retrieved from AudienceLab
- `kept`: Contacts included in the final CSV export
- `filteredMissingPhone`: Excluded due to missing phone (applies to `useCase=call`)
- `filteredInvalidEmail`: Excluded due to missing/invalid email (applies to `useCase=email`)
- `filteredDnc`: Excluded due to DNC (Do Not Call) flag (B2C only)
- `missingNameOrAddressCount`: Kept contacts that are missing name or address (informational)

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