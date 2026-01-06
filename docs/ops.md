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
- Requires `AUDIENCELAB_API_KEY` env var.
- Uses ZIP code lookup to enhance geographic targeting.
- Maps AudienceLab contact fields to Lead schema.
- Returns `provider_error` on API failure, `provider_no_results` on empty results.
- Source field: `audiencelab`.
- Caps results at 50 leads per request.

### Error Mapping
- `provider_error` → HTTP 502 (Bad Gateway)
- `provider_no_results` → HTTP 404 (Not Found)

## Rationale: Service Role Key Stays Server-only

- The service role key grants full access to Storage and Database.
- Exposing it to the client would allow unrestricted file operations.
- Therefore, it must be used only in serverless functions (Vercel) or Edge Functions and never bundled into client code.