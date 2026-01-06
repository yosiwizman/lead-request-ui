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

- Route: `POST /api/leads/generate`
- Request JSON:
  { "leadRequest": "string", "zipCodes": "string", "leadScope": "residential|commercial|both" }
- Validation:
  - `leadRequest` required, 3–200 chars
  - `zipCodes` parsed by comma/space; each ZIP must be 5 digits; 1–200 zips
  - `leadScope` required: `residential` | `commercial` | `both`
- Success Response:
  { "ok": true, "count": number, "bucket": "exports", "path": "<yyyy-mm-dd>/<ts>-<rand>.csv", "signedUrl": "string", "expiresInSeconds": 86400 }
- Error Response (standard shape):
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
- ProviderResult: `{ ok: true, leads: Lead[] }` or `{ ok: false, error: ProviderError }`
- Fallback behavior: when `LEAD_PROVIDER=audiencelab` but `AUDIENCELAB_API_KEY` is missing, silently falls back to mock.
- No silent fallback on runtime errors: when audiencelab is enabled and API call fails, returns error.

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