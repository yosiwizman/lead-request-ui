# Operations & Security Notes

## Supabase Storage

### `exports` bucket
- **Visibility:** PRIVATE (not public)
- **Purpose:** Stores generated lead CSV files
- **Access:** Server-side only via service role key
- Files are accessed via signed URLs with expiration

## Environment Variables

### Server-only (NOT exposed to client)
| Variable | Description |
|----------|-------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Full access key for server-side operations. Lives only in Vercel env vars. |

### Client-safe (exposed to browser)
| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Public/anon key for client-side auth |

## Security Rules

1. **Never expose `SUPABASE_SERVICE_ROLE_KEY` to the frontend**
   - Do not prefix with `VITE_`
   - Only use in API routes / Edge Functions

2. **Always use signed URLs for private bucket access**
   - Generate signed URLs server-side
   - Set reasonable expiration (e.g., 1 hour)

3. **Validate requests server-side**
   - Don't trust client-provided file paths
   - Sanitize filenames before storage

---

## API Endpoint Contract

- **Route:** `POST /api/leads/generate`
- **Request JSON:** 
  ```json
  { "leadRequest": "string", "zipCodes": "string", "leadScope": "residential|commercial|both" }
  ```
- **Validation:**
  - `leadRequest` required, 3–200 chars
  - `zipCodes` parsed by comma/space; each ZIP must be 5 digits; 1–200 zips
  - `leadScope` required: `residential` | `commercial` | `both`
- **Success Response:**
  ```json
  { "ok": true, "count": number, "filePath": "exports/<yyyy-mm-dd>/<ts>-<rand>.csv", "signedUrl": "string", "expiresInSeconds": 86400 }
  ```
- **Error Response (standard shape):**
  ```json
  { "ok": false, "error": { "code": "string", "message": "string", "details": { "...": "..." } } }
  ```

## Signed URL Behavior

- Files uploaded to the PRIVATE `exports` bucket.
- Signed URLs are generated server-side and returned to the client.
- Default expiration: **24 hours** (86,400 seconds).
- Clients should download immediately; URLs expire and cannot be refreshed without a new request.

## Provider Abstraction

- Default provider: `src/server/providers/mock.ts` (deterministic mock leads).
- Interface: `src/server/providers/provider.ts` (`generateLeads({ leadRequest, zips, scope }) -> Lead[]`).
- To add AudienceLab:
  - Implement `audiencelab.ts` module with the same interface.
  - Swap the import in `api/leads/generate.ts` to use AudienceLab.
  - Keep CSV + Storage logic unchanged.

## Rationale: Service Role Key Stays Server-only

- The service role key grants full access to Storage and Database.
- Exposing it to the client would allow unrestricted file operations.
- Therefore, it must be used only in serverless functions (Vercel) or Edge Functions and never bundled into client code.