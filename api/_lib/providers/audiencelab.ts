import type { Lead, GenerateInput, ProviderResult, LeadScope, LeadQualityDiagnostics, UseCase, FieldCoverage, FieldCoverageBlock, CoverageFieldName, MatchByTier } from '../types.js';
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
  BUSINESS_EMAIL_VALIDATION_STATUS?: string; // 'Valid' | 'Valid (Esp)' | 'Invalid' | etc.
  SKIPTRACE_B2B_WIRELESS?: string;
  SKIPTRACE_B2B_LANDLINE?: string;
  SKIPTRACE_B2B_MATCH_BY?: string; // e.g., 'COMPANY_ADDRESS,EMAIL' - deterministic matching
  COMPANY_ADDRESS?: string;
  
  // B2C quality fields (AudienceLab Fields Guide)
  PERSONAL_EMAIL?: string;
  PERSONAL_EMAIL_VALIDATION_STATUS?: string; // 'Valid' | 'Valid (Esp)' | 'Invalid' | etc.
  SKIPTRACE_WIRELESS_NUMBERS?: string;
  SKIPTRACE_LANDLINE_NUMBERS?: string;
  SKIPTRACE_MATCH_BY?: string; // e.g., 'ADDRESS,EMAIL,NAME' - deterministic matching
  DNC?: string; // 'Y' | 'N' | undefined - Do Not Call
  
  // Freshness indicator
  LAST_SEEN?: string; // ISO date string when contact was last active
}

interface AudienceLabMembersResponse {
  data?: AudienceLabContact[];
  members?: AudienceLabContact[];
  total?: number;
  page?: number;
  page_size?: number;
}

// =============================================================================
// RECIPE ENGINE
// Implements AudienceLab Fields Guide best practices for quality lead selection
// =============================================================================

/**
 * Recipe configuration for lead quality filtering.
 * Derived from leadScope + useCase combination.
 */
export interface RecipeConfig {
  /** Require email to have 'Valid (Esp)' validation status */
  requireEmailValidEsp: boolean;
  /** Require phone to be present */
  requirePhone: boolean;
  /** Exclude contacts with DNC=Y (B2C calling) */
  excludeDnc: boolean;
  /** Maximum days since LAST_SEEN for email use cases (0 = disabled) */
  freshnessDays: number;
  /** Use case type for logging/debugging */
  useCase: UseCase;
}

/**
 * Build recipe configuration based on scope and use case.
 * Implements AudienceLab Fields Guide recommendations:
 * - B2B Call: SKIPTRACE_B2B_WIRELESS/LANDLINE, prefer COMPANY_ADDRESS match
 * - B2B Email: BUSINESS_EMAIL with Valid(Esp) status, LAST_SEEN within 30 days
 * - B2C Call: SKIPTRACE_WIRELESS/LANDLINE, exclude DNC=Y, use SKIPTRACE_MATCH_BY
 * - B2C Email: PERSONAL_EMAIL with Valid(Esp) status, LAST_SEEN within 30 days
 */
export function buildRecipe(scope: LeadScope, useCase: UseCase): RecipeConfig {
  const isEmailUseCase = useCase === 'email';
  const isCallUseCase = useCase === 'call';
  const isB2C = scope === 'residential';
  
  return {
    requireEmailValidEsp: isEmailUseCase,
    requirePhone: isCallUseCase,
    excludeDnc: isB2C && (isCallUseCase || useCase === 'both'),
    freshnessDays: isEmailUseCase ? 30 : 0,
    useCase,
  };
}

/**
 * Evaluate match-by tier for accuracy ranking.
 * Based on AudienceLab SKIPTRACE_MATCH_BY documentation:
 * - High: Contains ADDRESS + EMAIL (most deterministic)
 * - Medium: Contains NAME + ADDRESS
 * - Low: Any other combination
 */
export function evaluateMatchByTier(contact: AudienceLabContact, scope: LeadScope): MatchByTier {
  const matchBy = scope === 'commercial' 
    ? (contact.SKIPTRACE_B2B_MATCH_BY || '').toUpperCase()
    : (contact.SKIPTRACE_MATCH_BY || '').toUpperCase();
  
  if (!matchBy) return 'low';
  
  const hasAddress = matchBy.includes('ADDRESS') || matchBy.includes('COMPANY_ADDRESS');
  const hasEmail = matchBy.includes('EMAIL');
  const hasName = matchBy.includes('NAME');
  
  // Highest accuracy: ADDRESS + EMAIL
  if (hasAddress && hasEmail) return 'high';
  
  // Medium accuracy: NAME + ADDRESS
  if (hasName && hasAddress) return 'medium';
  
  // Low accuracy: anything else
  return 'low';
}

/**
 * Check if email validation status is 'Valid (Esp)' - the highest quality.
 * AudienceLab considers 'Valid (Esp)' as deliverable email addresses.
 */
function isEmailValidEsp(validationStatus: string | undefined): boolean {
  if (!validationStatus) return false;
  const normalized = validationStatus.toLowerCase().trim();
  return normalized === 'valid (esp)' || normalized === 'valid(esp)';
}

/**
 * Check if email validation status is at least 'Valid' (including 'Valid (Esp)').
 */
function isEmailAtLeastValid(validationStatus: string | undefined): boolean {
  if (!validationStatus) return true; // No status = assume valid (legacy behavior)
  const normalized = validationStatus.toLowerCase().trim();
  return normalized.startsWith('valid');
}

/**
 * Check if LAST_SEEN date is within freshness window.
 * Returns true if no LAST_SEEN field or if within windowDays.
 */
function isWithinFreshnessWindow(lastSeen: string | undefined, windowDays: number): boolean {
  if (!lastSeen || windowDays === 0) return true;
  
  try {
    const lastSeenDate = new Date(lastSeen);
    const now = new Date();
    const diffMs = now.getTime() - lastSeenDate.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= windowDays;
  } catch {
    return true; // If date parsing fails, allow the contact
  }
}

/**
 * Look up city/state from ZIP code using embedded lookup.
 * Returns null if not found.
 */
export function lookupZipLocation(zip: string): { city: string; state: string } | null {
  return ZIP_LOOKUP[zip] || null;
}

/**
 * Email selection result with detailed validation info.
 */
interface EmailSelectionResult {
  email: string;
  isValid: boolean;
  isValidEsp: boolean;
  validationStatus: string | undefined;
}

/**
 * Select best email based on scope using AudienceLab Fields Guide.
 * B2B: Prefer BUSINESS_EMAIL with Valid status
 * B2C: Prefer PERSONAL_EMAIL with Valid status
 * Now also returns isValidEsp for recipe engine.
 */
function selectQualityEmail(contact: AudienceLabContact, scope: LeadScope): EmailSelectionResult {
  if (scope === 'commercial') {
    // B2B: BUSINESS_EMAIL preferred
    if (contact.BUSINESS_EMAIL) {
      const status = contact.BUSINESS_EMAIL_VALIDATION_STATUS;
      return { 
        email: contact.BUSINESS_EMAIL, 
        isValid: isEmailAtLeastValid(status),
        isValidEsp: isEmailValidEsp(status),
        validationStatus: status,
      };
    }
  } else {
    // B2C: PERSONAL_EMAIL preferred
    if (contact.PERSONAL_EMAIL) {
      const status = contact.PERSONAL_EMAIL_VALIDATION_STATUS;
      return { 
        email: contact.PERSONAL_EMAIL, 
        isValid: isEmailAtLeastValid(status),
        isValidEsp: isEmailValidEsp(status),
        validationStatus: status,
      };
    }
  }
  // Fallback to basic email field (no validation status)
  return { email: contact.email || '', isValid: true, isValidEsp: false, validationStatus: undefined };
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
 * Extended exclusion reasons for recipe engine.
 */
type ExclusionReason = 
  | 'dnc' 
  | 'invalid_email' 
  | 'invalid_email_esp' 
  | 'email_too_old' 
  | 'missing_phone' 
  | 'missing_contact';

/**
 * Quality filter result for diagnostics with tier ranking.
 */
interface QualityFilterResult {
  lead: Lead | null;
  excluded: ExclusionReason | null;
  missingNameOrAddress: boolean;
  tier: MatchByTier;
}

/**
 * The 8 core fields we track for coverage diagnostics.
 */
const COVERAGE_FIELDS: CoverageFieldName[] = [
  'first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email'
];

/**
 * Create an empty field coverage block with all counts at zero.
 */
function emptyFieldCoverageBlock(): FieldCoverageBlock {
  const present: Record<CoverageFieldName, number> = {
    first_name: 0, last_name: 0, address: 0, city: 0, state: 0, zip: 0, phone: 0, email: 0
  };
  const pct: Record<CoverageFieldName, number> = {
    first_name: 0, last_name: 0, address: 0, city: 0, state: 0, zip: 0, phone: 0, email: 0
  };
  return { total: 0, present, pct };
}

/**
 * Compute field coverage for raw AudienceLab contacts (before filtering).
 * Returns counts and percentages for each field. NO PII is logged or returned.
 */
export function computeContactsCoverage(contacts: AudienceLabContact[], scope: LeadScope): FieldCoverageBlock {
  if (contacts.length === 0) {
    return emptyFieldCoverageBlock();
  }

  const counts: Record<CoverageFieldName, number> = {
    first_name: 0, last_name: 0, address: 0, city: 0, state: 0, zip: 0, phone: 0, email: 0
  };

  for (const contact of contacts) {
    // Check each field for presence (non-empty string)
    if (contact.first_name?.trim()) counts.first_name++;
    if (contact.last_name?.trim()) counts.last_name++;
    
    // Address: check multiple possible fields
    const hasAddress = !!(contact.address?.trim() || contact.street_address?.trim() || 
      (scope === 'commercial' && contact.COMPANY_ADDRESS?.trim()));
    if (hasAddress) counts.address++;
    
    if (contact.city?.trim()) counts.city++;
    if (contact.state?.trim()) counts.state++;
    if (contact.zip?.trim() || contact.postal_code?.trim()) counts.zip++;
    
    // Phone: check multiple possible fields based on scope
    const hasPhone = scope === 'commercial'
      ? !!(contact.SKIPTRACE_B2B_WIRELESS?.trim() || contact.SKIPTRACE_B2B_LANDLINE?.trim() || contact.mobile_phone?.trim() || contact.phone?.trim())
      : !!(contact.SKIPTRACE_WIRELESS_NUMBERS?.trim() || contact.SKIPTRACE_LANDLINE_NUMBERS?.trim() || contact.mobile_phone?.trim() || contact.phone?.trim());
    if (hasPhone) counts.phone++;
    
    // Email: check multiple possible fields based on scope
    const hasEmail = scope === 'commercial'
      ? !!(contact.BUSINESS_EMAIL?.trim() || contact.email?.trim())
      : !!(contact.PERSONAL_EMAIL?.trim() || contact.email?.trim());
    if (hasEmail) counts.email++;
  }

  // Calculate percentages
  const total = contacts.length;
  const pct: Record<CoverageFieldName, number> = {} as Record<CoverageFieldName, number>;
  for (const field of COVERAGE_FIELDS) {
    pct[field] = Math.round((counts[field] / total) * 100);
  }

  return { total, present: counts, pct };
}

/**
 * Compute field coverage for kept leads (after filtering).
 * Takes Lead[] array which has already been filtered.
 */
export function computeLeadsCoverage(leads: Lead[]): FieldCoverageBlock {
  if (leads.length === 0) {
    return emptyFieldCoverageBlock();
  }

  const counts: Record<CoverageFieldName, number> = {
    first_name: 0, last_name: 0, address: 0, city: 0, state: 0, zip: 0, phone: 0, email: 0
  };

  for (const lead of leads) {
    if (lead.first_name?.trim()) counts.first_name++;
    if (lead.last_name?.trim()) counts.last_name++;
    if (lead.address?.trim()) counts.address++;
    if (lead.city?.trim()) counts.city++;
    if (lead.state?.trim()) counts.state++;
    if (lead.zip?.trim()) counts.zip++;
    if (lead.phone?.trim()) counts.phone++;
    if (lead.email?.trim()) counts.email++;
  }

  // Calculate percentages
  const total = leads.length;
  const pct: Record<CoverageFieldName, number> = {} as Record<CoverageFieldName, number>;
  for (const field of COVERAGE_FIELDS) {
    pct[field] = Math.round((counts[field] / total) * 100);
  }

  return { total, present: counts, pct };
}

/**
 * Map an AudienceLab contact to our Lead format with recipe-based quality filtering.
 * Uses AudienceLab Fields Guide + Recipe Engine for optimal field selection.
 * Applies recipe-based filtering:
 *   - 'call': require phone, exclude DNC for B2C, rank by match_by tier
 *   - 'email': require Valid(Esp) email, check LAST_SEEN freshness
 *   - 'both': either phone or email, best of both rules
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

  // Build recipe for this scope + useCase
  const recipe = buildRecipe(effectiveScope, useCase);
  
  // Compute match-by accuracy tier (used for ranking, not hard-filtering)
  const tier = evaluateMatchByTier(contact, effectiveScope);

  // Check DNC exclusion (B2C call/both only per recipe)
  if (recipe.excludeDnc && contact.DNC?.toUpperCase() === 'Y') {
    return { lead: null, excluded: 'dnc', missingNameOrAddress: false, tier };
  }

  // Select quality email with enhanced validation info
  const emailResult = selectQualityEmail(contact, effectiveScope);
  const { email, isValid: emailValid, isValidEsp } = emailResult;
  
  // For 'email' useCase: require Valid(Esp) email per recipe
  if (recipe.requireEmailValidEsp) {
    if (!email) {
      return { lead: null, excluded: 'invalid_email', missingNameOrAddress: false, tier };
    }
    if (!isValidEsp) {
      return { lead: null, excluded: 'invalid_email_esp', missingNameOrAddress: false, tier };
    }
    // Check LAST_SEEN freshness for email use case
    if (!isWithinFreshnessWindow(contact.LAST_SEEN, recipe.freshnessDays)) {
      return { lead: null, excluded: 'email_too_old', missingNameOrAddress: false, tier };
    }
  } else {
    // For 'call' and 'both': exclude contacts with explicitly invalid emails (but allow missing)
    if (email && !emailValid) {
      return { lead: null, excluded: 'invalid_email', missingNameOrAddress: false, tier };
    }
  }

  // Select quality phone
  const phone = selectQualityPhone(contact, effectiveScope);

  // For 'call' useCase: require phone present per recipe
  if (recipe.requirePhone && !phone) {
    return { lead: null, excluded: 'missing_phone', missingNameOrAddress: false, tier };
  }

  // For 'both' useCase: need at least phone or email
  if (useCase === 'both' && !phone && !email) {
    return { lead: null, excluded: 'missing_contact', missingNameOrAddress: false, tier };
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

  return { lead, excluded: null, missingNameOrAddress, tier };
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

    // Compute field coverage for raw contacts BEFORE filtering
    const coverageFetched = computeContactsCoverage(allContacts, input.scope);

    // Map contacts to leads with recipe-based quality filtering
    const diagnostics: LeadQualityDiagnostics = {
      totalFetched: allContacts.length,
      kept: 0,
      filteredMissingPhone: 0,
      filteredInvalidEmail: 0,
      filteredInvalidEmailEsp: 0,
      filteredEmailTooOld: 0,
      filteredDnc: 0,
      missingNameOrAddressCount: 0,
      matchByTier: { high: 0, medium: 0, low: 0 },
    };
    
    // First pass: filter and collect leads with their tiers
    const leadsWithTier: Array<{ lead: Lead; tier: MatchByTier; missingNameOrAddress: boolean }> = [];
    for (let i = 0; i < allContacts.length; i++) {
      const result = mapAudienceLabContactToLead(allContacts[i], input, i);
      if (result.lead) {
        leadsWithTier.push({ 
          lead: result.lead, 
          tier: result.tier, 
          missingNameOrAddress: result.missingNameOrAddress 
        });
      } else {
        // Track exclusion reasons for diagnostics
        switch (result.excluded) {
          case 'invalid_email': diagnostics.filteredInvalidEmail++; break;
          case 'invalid_email_esp': diagnostics.filteredInvalidEmailEsp++; break;
          case 'email_too_old': diagnostics.filteredEmailTooOld++; break;
          case 'dnc': diagnostics.filteredDnc++; break;
          case 'missing_phone': diagnostics.filteredMissingPhone++; break;
          case 'missing_contact': diagnostics.filteredMissingPhone++; break; // Count as missing phone for backwards compat
        }
      }
    }
    
    // Sort by tier (high > medium > low) to keep best leads
    const tierOrder: Record<MatchByTier, number> = { high: 0, medium: 1, low: 2 };
    leadsWithTier.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
    
    // Take top N leads and track tier counts
    const leads: Lead[] = [];
    for (let i = 0; i < leadsWithTier.length && leads.length < maxLeads; i++) {
      const item = leadsWithTier[i];
      leads.push(item.lead);
      diagnostics.matchByTier[item.tier]++;
      if (item.missingNameOrAddress) {
        diagnostics.missingNameOrAddressCount++;
      }
    }
    diagnostics.kept = leads.length;

    // Compute field coverage for kept leads AFTER filtering
    const coverageKept = computeLeadsCoverage(leads);
    const fieldCoverage: FieldCoverage = { coverageFetched, coverageKept };

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
            fieldCoverage,
          },
        },
      };
    }

    return { ok: true, leads, audienceId, requestId, diagnostics, fieldCoverage };
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

    // Compute field coverage for raw contacts BEFORE filtering
    const coverageFetched = computeContactsCoverage(allContacts, input.scope);

    // Apply recipe-based quality filtering
    const diagnostics: LeadQualityDiagnostics = {
      totalFetched: allContacts.length,
      kept: 0,
      filteredMissingPhone: 0,
      filteredInvalidEmail: 0,
      filteredInvalidEmailEsp: 0,
      filteredEmailTooOld: 0,
      filteredDnc: 0,
      missingNameOrAddressCount: 0,
      matchByTier: { high: 0, medium: 0, low: 0 },
    };
    
    // First pass: filter and collect leads with their tiers
    const leadsWithTier: Array<{ lead: Lead; tier: MatchByTier; missingNameOrAddress: boolean }> = [];
    for (let i = 0; i < allContacts.length; i++) {
      const result = mapAudienceLabContactToLead(allContacts[i], input, i);
      if (result.lead) {
        leadsWithTier.push({ 
          lead: result.lead, 
          tier: result.tier, 
          missingNameOrAddress: result.missingNameOrAddress 
        });
      } else {
        switch (result.excluded) {
          case 'invalid_email': diagnostics.filteredInvalidEmail++; break;
          case 'invalid_email_esp': diagnostics.filteredInvalidEmailEsp++; break;
          case 'email_too_old': diagnostics.filteredEmailTooOld++; break;
          case 'dnc': diagnostics.filteredDnc++; break;
          case 'missing_phone': diagnostics.filteredMissingPhone++; break;
          case 'missing_contact': diagnostics.filteredMissingPhone++; break;
        }
      }
    }
    
    // Sort by tier (high > medium > low) to keep best leads
    const tierOrder: Record<MatchByTier, number> = { high: 0, medium: 1, low: 2 };
    leadsWithTier.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
    
    // Take top N leads and track tier counts
    const leads: Lead[] = [];
    for (let i = 0; i < leadsWithTier.length && leads.length < maxLeads; i++) {
      const item = leadsWithTier[i];
      leads.push(item.lead);
      diagnostics.matchByTier[item.tier]++;
      if (item.missingNameOrAddress) {
        diagnostics.missingNameOrAddressCount++;
      }
    }
    diagnostics.kept = leads.length;

    // Compute field coverage for kept leads AFTER filtering
    const coverageKept = computeLeadsCoverage(leads);
    const fieldCoverage: FieldCoverage = { coverageFetched, coverageKept };

    if (leads.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Contacts found but all filtered out. May still be building.',
          details: { audienceId, requestId: effectiveRequestId, retryAfterSeconds: 2, diagnostics, fieldCoverage },
        },
      };
    }

    return { ok: true, leads, audienceId, requestId: effectiveRequestId, diagnostics, fieldCoverage };
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
