import type { Lead, GenerateInput, ProviderResult, LeadScope, LeadQualityDiagnostics, UseCase } from '../types.js';
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

/**
 * AudienceLab contact with Fields Guide quality fields.
 * See: AudienceLab Fields Guide for B2B/B2C best practices.
 */
interface AudienceLabContact {
  // Basic fields
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
  
  // B2B quality fields (AudienceLab Fields Guide)
  BUSINESS_EMAIL?: string;
  BUSINESS_EMAIL_VALIDATION_STATUS?: string; // 'Valid' | 'Invalid' | etc.
  SKIPTRACE_B2B_WIRELESS?: string;
  SKIPTRACE_B2B_LANDLINE?: string;
  COMPANY_ADDRESS?: string;
  
  // B2C quality fields (AudienceLab Fields Guide)
  PERSONAL_EMAIL?: string;
  PERSONAL_EMAIL_VALIDATION_STATUS?: string; // 'Valid' | 'Invalid' | etc.
  SKIPTRACE_WIRELESS_NUMBERS?: string;
  SKIPTRACE_LANDLINE_NUMBERS?: string;
  DNC?: string; // 'Y' | 'N' | undefined - Do Not Call
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
 * Select best email based on scope using AudienceLab Fields Guide.
 * B2B: Prefer BUSINESS_EMAIL with Valid status
 * B2C: Prefer PERSONAL_EMAIL with Valid status
 */
function selectQualityEmail(contact: AudienceLabContact, scope: LeadScope): { email: string; isValid: boolean } {
  if (scope === 'commercial') {
    // B2B: BUSINESS_EMAIL preferred
    if (contact.BUSINESS_EMAIL) {
      const isValid = contact.BUSINESS_EMAIL_VALIDATION_STATUS?.toLowerCase() === 'valid';
      return { email: contact.BUSINESS_EMAIL, isValid: isValid || contact.BUSINESS_EMAIL_VALIDATION_STATUS === undefined };
    }
  } else {
    // B2C: PERSONAL_EMAIL preferred
    if (contact.PERSONAL_EMAIL) {
      const isValid = contact.PERSONAL_EMAIL_VALIDATION_STATUS?.toLowerCase() === 'valid';
      return { email: contact.PERSONAL_EMAIL, isValid: isValid || contact.PERSONAL_EMAIL_VALIDATION_STATUS === undefined };
    }
  }
  // Fallback to basic email field
  return { email: contact.email || '', isValid: true };
}

/**
 * Select best phone based on scope using AudienceLab Fields Guide.
 * B2B: SKIPTRACE_B2B_WIRELESS > SKIPTRACE_B2B_LANDLINE > mobile_phone > phone
 * B2C: SKIPTRACE_WIRELESS_NUMBERS > SKIPTRACE_LANDLINE_NUMBERS > mobile_phone > phone
 */
function selectQualityPhone(contact: AudienceLabContact, scope: LeadScope): string {
  if (scope === 'commercial') {
    // B2B phone hierarchy
    return contact.SKIPTRACE_B2B_WIRELESS 
      || contact.SKIPTRACE_B2B_LANDLINE 
      || contact.mobile_phone 
      || contact.phone 
      || '';
  } else {
    // B2C phone hierarchy
    return contact.SKIPTRACE_WIRELESS_NUMBERS 
      || contact.SKIPTRACE_LANDLINE_NUMBERS 
      || contact.mobile_phone 
      || contact.phone 
      || '';
  }
}

/**
 * Check if contact should be excluded due to DNC (Do Not Call).
 * Only applies to B2C (residential) scope.
 */
function isDncExcluded(contact: AudienceLabContact, scope: LeadScope): boolean {
  if (scope === 'commercial') return false; // DNC typically for B2C
  return contact.DNC?.toUpperCase() === 'Y';
}

/**
 * Quality filter result for diagnostics.
 */
interface QualityFilterResult {
  lead: Lead | null;
  excluded: 'dnc' | 'invalid_email' | 'missing_phone' | 'missing_contact' | null;
  missingNameOrAddress: boolean;
}

/**
 * Map an AudienceLab contact to our Lead format with quality filtering.
 * Uses AudienceLab Fields Guide for optimal field selection.
 * Applies useCase-based filtering:
 *   - 'call': require phone present
 *   - 'email': require valid email present
 *   - 'both': either phone or email
 */
export function mapAudienceLabContactToLead(
  contact: AudienceLabContact,
  input: GenerateInput,
  index: number
): QualityFilterResult {
  const useCase: UseCase = input.useCase || 'both';
  
  // Determine effective scope for this contact
  let effectiveScope: LeadScope;
  if (input.scope === 'both') {
    effectiveScope = index % 2 === 0 ? 'residential' : 'commercial';
  } else {
    effectiveScope = input.scope;
  }

  // Check DNC exclusion (B2C only)
  if (isDncExcluded(contact, effectiveScope)) {
    return { lead: null, excluded: 'dnc', missingNameOrAddress: false };
  }

  // Select quality email
  const { email, isValid: emailValid } = selectQualityEmail(contact, effectiveScope);
  
  // For 'email' useCase: require valid email
  if (useCase === 'email') {
    if (!email || !emailValid) {
      return { lead: null, excluded: 'invalid_email', missingNameOrAddress: false };
    }
  } else {
    // For 'call' and 'both': exclude contacts with explicitly invalid emails (but allow missing)
    if (email && !emailValid) {
      return { lead: null, excluded: 'invalid_email', missingNameOrAddress: false };
    }
  }

  // Select quality phone
  const phone = selectQualityPhone(contact, effectiveScope);

  // For 'call' useCase: require phone present
  if (useCase === 'call' && !phone) {
    return { lead: null, excluded: 'missing_phone', missingNameOrAddress: false };
  }

  // For 'both' useCase: need at least phone or email
  if (useCase === 'both' && !phone && !email) {
    return { lead: null, excluded: 'missing_contact', missingNameOrAddress: false };
  }

  // Select address (B2B: prefer COMPANY_ADDRESS)
  let address = contact.address || contact.street_address || '';
  if (effectiveScope === 'commercial' && contact.COMPANY_ADDRESS) {
    address = contact.COMPANY_ADDRESS;
  }

  // Check for missing name or address (for quality summary, not exclusion)
  const hasName = !!(contact.first_name || contact.last_name);
  const hasAddress = !!address;
  const missingNameOrAddress = !hasName || !hasAddress;

  const lead: Lead = {
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    address,
    city: contact.city || '',
    state: contact.state || '',
    zip: contact.zip || contact.postal_code || '',
    phone,
    email,
    lead_type: effectiveScope,
    tags: input.leadRequest,
    source: 'audiencelab',
  };

  return { lead, excluded: null, missingNameOrAddress };
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

    // If no contacts yet, return building status (audience may still be populating)
    if (allContacts.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Audience is building. Please poll for results.',
          details: { 
            zips: input.zips, 
            scope: input.scope, 
            audienceId,
            requestId,
            retryAfterSeconds: 2,
          },
        },
      };
    }

    // Map contacts to leads with quality filtering (cap at 50)
    const diagnostics: LeadQualityDiagnostics = {
      totalFetched: allContacts.length,
      kept: 0,
      filteredMissingPhone: 0,
      filteredInvalidEmail: 0,
      filteredDnc: 0,
      missingNameOrAddressCount: 0,
    };
    
    const leads: Lead[] = [];
    for (let i = 0; i < allContacts.length && leads.length < maxLeads; i++) {
      const result = mapAudienceLabContactToLead(allContacts[i], input, i);
      if (result.lead) {
        leads.push(result.lead);
        if (result.missingNameOrAddress) {
          diagnostics.missingNameOrAddressCount++;
        }
      } else {
        // Track exclusion reasons for diagnostics
        switch (result.excluded) {
          case 'invalid_email': diagnostics.filteredInvalidEmail++; break;
          case 'dnc': diagnostics.filteredDnc++; break;
          case 'missing_phone': diagnostics.filteredMissingPhone++; break;
          case 'missing_contact': diagnostics.filteredMissingPhone++; break; // Count as missing phone for backwards compat
        }
      }
    }
    diagnostics.kept = leads.length;

    // If all contacts were filtered out, still return building (might get more data)
    if (leads.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Audience has contacts but all were filtered. May still be building.',
          details: { 
            audienceId,
            requestId,
            retryAfterSeconds: 2,
            diagnostics,
          },
        },
      };
    }

    return { ok: true, leads, audienceId, requestId, diagnostics };
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

/**
 * Fetch members for an existing audience (used for polling by status endpoint).
 * Returns building status if no members yet, or leads if available.
 */
export async function fetchAudienceMembers(
  audienceId: string,
  input: GenerateInput,
  requestId?: string
): Promise<ProviderResult> {
  const effectiveRequestId = requestId || generateRequestId();
  
  const apiKey = sanitizeByteString(
    process.env.AUDIENCELAB_API_KEY,
    'AUDIENCELAB_API_KEY'
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  };

  const allContacts: AudienceLabContact[] = [];
  let page = 1;
  const pageSize = 50;
  const maxLeads = 50;

  try {
    while (allContacts.length < maxLeads) {
      const membersUrl = `${BASE_URL}/audiences/${audienceId}?page=${page}&page_size=${pageSize}`;
      
      const membersResponse = await fetch(membersUrl, {
        method: 'GET',
        headers,
      });

      if (!membersResponse.ok) {
        const upstreamRequestId = membersResponse.headers.get('x-request-id') ?? undefined;
        const memberEndpoint = `/audiences/${audienceId}`;
        
        if (membersResponse.status === 401 || membersResponse.status === 403) {
          throw new AudienceLabAuthError({
            status: membersResponse.status,
            endpoint: memberEndpoint,
            method: 'GET',
            requestId: upstreamRequestId || effectiveRequestId,
          });
        }
        
        if (membersResponse.status >= 500) {
          throw new AudienceLabUpstreamError({
            status: membersResponse.status,
            endpoint: memberEndpoint,
            method: 'GET',
            requestId: upstreamRequestId || effectiveRequestId,
          });
        }
        
        return {
          ok: false,
          error: {
            code: 'provider_error',
            message: `AudienceLab API returned ${membersResponse.status} fetching members`,
            details: { status: membersResponse.status, audienceId, requestId: effectiveRequestId },
          },
        };
      }

      const membersData: AudienceLabMembersResponse = await membersResponse.json();
      const contacts = membersData.data || membersData.members || [];

      if (contacts.length === 0) break;
      allContacts.push(...contacts);
      if (contacts.length < pageSize) break;
      page++;
      if (page > 10) break;
    }

    // Still building if no contacts
    if (allContacts.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Audience is still building.',
          details: { audienceId, requestId: effectiveRequestId, retryAfterSeconds: 2 },
        },
      };
    }

    // Apply quality filtering
    const diagnostics: LeadQualityDiagnostics = {
      totalFetched: allContacts.length,
      kept: 0,
      filteredMissingPhone: 0,
      filteredInvalidEmail: 0,
      filteredDnc: 0,
      missingNameOrAddressCount: 0,
    };
    
    const leads: Lead[] = [];
    for (let i = 0; i < allContacts.length && leads.length < maxLeads; i++) {
      const result = mapAudienceLabContactToLead(allContacts[i], input, i);
      if (result.lead) {
        leads.push(result.lead);
        if (result.missingNameOrAddress) {
          diagnostics.missingNameOrAddressCount++;
        }
      } else {
        switch (result.excluded) {
          case 'invalid_email': diagnostics.filteredInvalidEmail++; break;
          case 'dnc': diagnostics.filteredDnc++; break;
          case 'missing_phone': diagnostics.filteredMissingPhone++; break;
          case 'missing_contact': diagnostics.filteredMissingPhone++; break;
        }
      }
    }
    diagnostics.kept = leads.length;

    if (leads.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Contacts found but all filtered out. May still be building.',
          details: { audienceId, requestId: effectiveRequestId, retryAfterSeconds: 2, diagnostics },
        },
      };
    }

    return { ok: true, leads, audienceId, requestId: effectiveRequestId, diagnostics };
  } catch (err) {
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
        message: `AudienceLab fetch members failed: ${message}`,
      },
    };
  }
}
