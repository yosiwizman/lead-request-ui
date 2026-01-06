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
- Throws typed errors: `AudienceLabAuthError` (401/403), `AudienceLabUpstreamError` (5xx).
- Returns `provider_error` on other API failures, `provider_no_results` on empty results.
- Source field: `audiencelab`.
- Caps results at 50 leads per request.

### Error Mapping
- `AUDIENCELAB_UNAUTHORIZED` → HTTP 502 (auth failure, includes hint)
- `AUDIENCELAB_UPSTREAM_ERROR` → HTTP 502 (service error)
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

## Rationale: Service Role Key Stays Server-only

- The service role key grants full access to Storage and Database.
- Exposing it to the client would allow unrestricted file operations.
- Therefore, it must be used only in serverless functions (Vercel) or Edge Functions and never bundled into client code.