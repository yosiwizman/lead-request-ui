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
