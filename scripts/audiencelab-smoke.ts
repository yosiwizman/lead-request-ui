#!/usr/bin/env npx tsx
/**
 * AudienceLab API Key Smoke Test
 * 
 * Verifies the AUDIENCELAB_API_KEY is valid and has appropriate permissions.
 * 
 * Usage:
 *   pnpm smoke:audiencelab
 *   AUDIENCELAB_API_KEY=xxx npx tsx scripts/audiencelab-smoke.ts
 * 
 * Exit codes:
 *   0 - Success (200 response)
 *   1 - Auth failure (401/403) or other error
 */

const BASE_URL = process.env.AUDIENCELAB_BASE_URL || 'https://api.audiencelab.io';

/**
 * Mask an API key for safe logging: shows first 4 and last 4 chars only.
 */
function maskKey(key: string): string {
  if (key.length <= 8) {
    return '****';
  }
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function main(): Promise<void> {
  const apiKey = process.env.AUDIENCELAB_API_KEY;

  console.log('🔍 AudienceLab Smoke Test');
  console.log('========================');
  console.log(`Base URL: ${BASE_URL}`);

  if (!apiKey) {
    console.error('❌ AUDIENCELAB_API_KEY is not set');
    process.exit(1);
  }

  console.log(`API Key:  ${maskKey(apiKey)}`);
  console.log('');

  const endpoint = `${BASE_URL}/audiences?page=1&page_size=1`;
  console.log(`Testing: GET ${endpoint.replace(BASE_URL, '')}`);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json',
      },
    });

    const requestId = response.headers.get('x-request-id');
    
    console.log('');
    console.log('Response:');
    console.log(`  Status:     ${response.status} ${response.statusText}`);
    if (requestId) {
      console.log(`  Request ID: ${requestId}`);
    }

    if (response.ok) {
      console.log('');
      console.log('✅ AudienceLab API key is valid');
      process.exit(0);
    }

    // Auth failures
    if (response.status === 401 || response.status === 403) {
      console.log('');
      console.log('❌ Authentication/Authorization failed');
      console.log('');
      console.log('Possible causes:');
      console.log('  • Invalid API key');
      console.log('  • Revoked API key');
      console.log('  • Wrong workspace');
      console.log('  • Missing required permissions (WRITE needed for create)');
      console.log('');
      console.log('Resolution:');
      console.log('  1. Go to AudienceLab dashboard → Settings → API Keys');
      console.log('  2. Create a new key with WRITE permission');
      console.log('  3. Update AUDIENCELAB_API_KEY in Vercel env vars');
      process.exit(1);
    }

    // Other errors
    let body = '';
    try {
      body = await response.text();
    } catch {
      // ignore body parse errors
    }
    
    console.log('');
    console.log(`❌ Unexpected response: ${response.status}`);
    if (body) {
      // Truncate long bodies
      const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
      console.log(`  Body: ${truncated}`);
    }
    process.exit(1);

  } catch (err) {
    console.log('');
    console.error('❌ Network error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
