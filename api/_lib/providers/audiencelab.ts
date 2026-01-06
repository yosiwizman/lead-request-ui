import type { Lead, GenerateInput, ProviderResult } from '../types.js';
import {
  AudienceLabAuthError,
  AudienceLabUpstreamError,
  AudienceLabContractError,
  AudienceLabAsyncError,
} from '../types.js';
import { sanitizeByteString } from '../bytestring.js';
import {
  extractAudienceId,
  describeShape,
  generateRequestId,
} from '../audiencelab-response.js';

const BASE_URL = process.env.AUDIENCELAB_BASE_URL || 'https://api.audiencelab.io';

// Simple ZIP to city/state lookup for common US zips
// This is a minimal embedded lookup; for production, consider a more complete dataset
const ZIP_LOOKUP: Record<string, { city: string; state: string }> = {
  '33101': { city: 'Miami', state: 'FL' },
  '33130': { city: 'Miami', state: 'FL' },
  '33139': { city: 'Miami Beach', state: 'FL' },
  '90210': { city: 'Beverly Hills', state: 'CA' },
  '10001': { city: 'New York', state: 'NY' },
  '60601': { city: 'Chicago', state: 'IL' },
  '77001': { city: 'Houston', state: 'TX' },
  '85001': { city: 'Phoenix', state: 'AZ' },
  '19101': { city: 'Philadelphia', state: 'PA' },
  '78201': { city: 'San Antonio', state: 'TX' },
  '92101': { city: 'San Diego', state: 'CA' },
  '75201': { city: 'Dallas', state: 'TX' },
};

interface AudienceLabContact {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  mobile_phone?: string;
  address?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  postal_code?: string;
  company?: string;
}

interface AudienceLabMembersResponse {
  data?: AudienceLabContact[];
  members?: AudienceLabContact[];
  total?: number;
  page?: number;
  page_size?: number;
}

/**
 * Look up city/state from ZIP code using embedded lookup.
 * Returns null if not found.
 */
export function lookupZipLocation(zip: string): { city: string; state: string } | null {
  return ZIP_LOOKUP[zip] || null;
}

/**
 * Map an AudienceLab contact to our Lead format.
 */
export function mapAudienceLabContactToLead(
  contact: AudienceLabContact,
  input: GenerateInput,
  index: number
): Lead {
  // For scope='both', alternate between residential and commercial
  let leadType: string;
  if (input.scope === 'both') {
    leadType = index % 2 === 0 ? 'residential' : 'commercial';
  } else {
    leadType = input.scope;
  }

  return {
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    address: contact.address || contact.street_address || '',
    city: contact.city || '',
    state: contact.state || '',
    zip: contact.zip || contact.postal_code || '',
    phone: contact.phone || contact.mobile_phone || '',
    email: contact.email || '',
    lead_type: leadType,
    tags: input.leadRequest,
    source: 'audiencelab',
  };
}

/**
 * Build audience creation payload with geographic hints from ZIP codes.
 */
function buildAudiencePayload(input: GenerateInput): Record<string, unknown> {
  // Try to extract city/state from first ZIP for better targeting
  const locations: Array<{ city?: string; state?: string; zip?: string }> = [];
  
  for (const zip of input.zips.slice(0, 5)) { // Limit to first 5 zips
    const location = lookupZipLocation(zip);
    if (location) {
      locations.push({ city: location.city, state: location.state, zip });
    } else {
      locations.push({ zip });
    }
  }

  return {
    name: `Lead Request: ${input.leadRequest.slice(0, 50)}`,
    description: input.leadRequest,
    filters: {
      keywords: input.leadRequest,
      locations: locations.length > 0 ? locations : undefined,
      zip_codes: input.zips,
    },
    size: 50,
  };
}

export async function generateLeads(
  input: GenerateInput
): Promise<ProviderResult> {
  // Generate a correlation ID for this request
  const requestId = generateRequestId();
  
  // Sanitize API key - strips BOM, trims, validates Latin1 (ByteString-safe)
  // Throws ConfigError if invalid (caught at route boundary)
  const apiKey = sanitizeByteString(
    process.env.AUDIENCELAB_API_KEY,
    'AUDIENCELAB_API_KEY'
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  };

  try {
    // Step 1: Create an audience
    const audiencePayload = buildAudiencePayload(input);
    const createUrl = `${BASE_URL}/audiences`;
    
    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(audiencePayload),
    });

    if (!createResponse.ok) {
      const upstreamRequestId = createResponse.headers.get('x-request-id') ?? undefined;
      
      // Throw typed error for auth failures
      if (createResponse.status === 401 || createResponse.status === 403) {
        throw new AudienceLabAuthError({
          status: createResponse.status,
          endpoint: '/audiences',
          method: 'POST',
          requestId: upstreamRequestId || requestId,
        });
      }
      
      // Throw typed error for upstream failures (5xx)
      if (createResponse.status >= 500) {
        throw new AudienceLabUpstreamError({
          status: createResponse.status,
          endpoint: '/audiences',
          method: 'POST',
          requestId: upstreamRequestId || requestId,
        });
      }
      
      // Other errors (4xx except 401/403)
      return {
        ok: false,
        error: {
          code: 'provider_error',
          message: `AudienceLab API returned ${createResponse.status} on audience creation`,
          details: { status: createResponse.status, requestId },
        },
      };
    }

    // Parse response and extract audience ID using robust extractor
    const audienceData = await createResponse.json();
    const extractResult = extractAudienceId(audienceData, createResponse.headers);

    if (!extractResult.ok) {
      // Handle different failure reasons
      if (extractResult.reason === 'async') {
        throw new AudienceLabAsyncError({
          endpoint: '/audiences',
          method: 'POST',
          requestId,
          jobId: extractResult.jobId,
          taskId: extractResult.taskId,
        });
      }
      
      if (extractResult.reason === 'error_payload') {
        throw new AudienceLabContractError({
          code: 'AUDIENCELAB_ERROR_PAYLOAD',
          endpoint: '/audiences',
          method: 'POST',
          requestId,
          responseShape: describeShape(audienceData),
          upstreamMessage: extractResult.errorMessage,
        });
      }
      
      // reason === 'not_found'
      throw new AudienceLabContractError({
        code: 'AUDIENCELAB_NO_AUDIENCE_ID',
        endpoint: '/audiences',
        method: 'POST',
        requestId,
        responseShape: extractResult.shape,
      });
    }

    const audienceId = extractResult.audienceId;

    // Step 2: Fetch audience members (paginate up to 50 leads)
    const allContacts: AudienceLabContact[] = [];
    let page = 1;
    const pageSize = 50;
    const maxLeads = 50;

    while (allContacts.length < maxLeads) {
      const membersUrl = `${BASE_URL}/audiences/${audienceId}?page=${page}&page_size=${pageSize}`;
      
      const membersResponse = await fetch(membersUrl, {
        method: 'GET',
        headers,
      });

      if (!membersResponse.ok) {
        const upstreamRequestId = membersResponse.headers.get('x-request-id') ?? undefined;
        const memberEndpoint = `/audiences/${audienceId}`;
        
        // Throw typed error for auth failures
        if (membersResponse.status === 401 || membersResponse.status === 403) {
          throw new AudienceLabAuthError({
            status: membersResponse.status,
            endpoint: memberEndpoint,
            method: 'GET',
            requestId: upstreamRequestId || requestId,
          });
        }
        
        // Throw typed error for upstream failures (5xx)
        if (membersResponse.status >= 500) {
          throw new AudienceLabUpstreamError({
            status: membersResponse.status,
            endpoint: memberEndpoint,
            method: 'GET',
            requestId: upstreamRequestId || requestId,
          });
        }
        
        // Other errors
        return {
          ok: false,
          error: {
            code: 'provider_error',
            message: `AudienceLab API returned ${membersResponse.status} fetching members`,
            details: { status: membersResponse.status, audienceId, requestId },
          },
        };
      }

      const membersData: AudienceLabMembersResponse = await membersResponse.json();
      const contacts = membersData.data || membersData.members || [];

      if (contacts.length === 0) {
        break; // No more data
      }

      allContacts.push(...contacts);
      
      // Check if we have enough or if there's no more data
      if (contacts.length < pageSize) {
        break;
      }
      
      page++;
      
      // Safety limit on pagination
      if (page > 10) {
        break;
      }
    }

    if (allContacts.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_no_results',
          message: 'No leads found for the given criteria.',
          details: { zips: input.zips, scope: input.scope, audienceId },
        },
      };
    }

    // Map contacts to leads (cap at 50)
    const leads = allContacts
      .slice(0, maxLeads)
      .map((contact, index) => mapAudienceLabContactToLead(contact, input, index));

    return { ok: true, leads };
  } catch (err) {
    // Re-throw typed errors for upstream handling
    if (
      err instanceof AudienceLabAuthError ||
      err instanceof AudienceLabUpstreamError ||
      err instanceof AudienceLabContractError ||
      err instanceof AudienceLabAsyncError
    ) {
      throw err;
    }
    
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      ok: false,
      error: {
        code: 'provider_error',
        message: `AudienceLab request failed: ${message}`,
      },
    };
  }
}
