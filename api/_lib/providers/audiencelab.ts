import type { Lead, GenerateInput, ProviderResult, LeadScope, LeadQualityDiagnostics, UseCase, FieldCoverage, FieldCoverageBlock, CoverageFieldName, MatchByTier, MatchScoreDistribution } from '../types.js';
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
 * 
 * Note: AudienceLab may return fields in various locations:
 * - Root level: contact.FIELD_NAME
 * - Nested: contact.fields.FIELD_NAME, contact.data.FIELD_NAME, contact.profile.FIELD_NAME
 * Use getField() accessor to read fields robustly.
 */
interface AudienceLabContact {
  // Basic fields (online/profile data)
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
  SKIPTRACE_B2B_WIRELESS_PHONE?: string; // Alternative field name
  SKIPTRACE_B2B_LANDLINE?: string;
  SKIPTRACE_B2B_LANDLINE_PHONE?: string; // Alternative field name
  SKIPTRACE_B2B_MATCH_BY?: string; // e.g., 'COMPANY_ADDRESS,EMAIL' - deterministic matching
  COMPANY_ADDRESS?: string;
  
  // B2C quality fields (AudienceLab Fields Guide)
  PERSONAL_EMAIL?: string;
  PERSONAL_EMAIL_VALIDATION_STATUS?: string; // 'Valid' | 'Valid (Esp)' | 'Invalid' | etc.
  SKIPTRACE_WIRELESS_NUMBERS?: string;
  SKIPTRACE_LANDLINE_NUMBERS?: string;
  SKIPTRACE_MATCH_BY?: string; // e.g., 'ADDRESS,EMAIL,NAME' - deterministic matching
  DNC?: string; // 'Y' | 'N' | undefined - Do Not Call
  
  // Skiptrace/offline identity fields (higher priority for outbound)
  SKIPTRACE_NAME?: string; // Full name from skiptrace (e.g., 'John Smith')
  SKIPTRACE_FIRST_NAME?: string;
  SKIPTRACE_LAST_NAME?: string;
  SKIPTRACE_ADDRESS?: string; // Verified mailing address
  SKIPTRACE_CITY?: string;
  SKIPTRACE_STATE?: string;
  SKIPTRACE_ZIP?: string;
  
  // Alternative field names (case variations)
  FIRST_NAME?: string;
  LAST_NAME?: string;
  
  // Freshness indicator
  LAST_SEEN?: string; // ISO date string when contact was last active
  
  // Nested containers (AudienceLab may nest fields here)
  fields?: Record<string, unknown>;
  data?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any; // Allow arbitrary field access
}

// =============================================================================
// FIELD ACCESSOR & PARSING UTILITIES
// Robust extraction of fields from various AudienceLab response shapes
// =============================================================================

/**
 * Defensive field accessor that checks multiple locations for a field value.
 * AudienceLab responses may have fields at root level or nested in fields/data/profile.
 * 
 * @param contact - The contact object to read from
 * @param fieldName - The field name to look up (case-sensitive)
 * @returns The field value as string, or undefined if not found
 */
export function getField(contact: AudienceLabContact, fieldName: string): string | undefined {
  // Check root level first
  const rootValue = contact[fieldName];
  if (rootValue !== undefined && rootValue !== null && rootValue !== '') {
    return String(rootValue);
  }
  
  // Check nested containers
  const containers = [contact.fields, contact.data, contact.profile];
  for (const container of containers) {
    if (container && typeof container === 'object') {
      const nestedValue = container[fieldName];
      if (nestedValue !== undefined && nestedValue !== null && nestedValue !== '') {
        return String(nestedValue);
      }
    }
  }
  
  return undefined;
}

/**
 * Parse a full name (e.g., 'John Smith') into first and last name.
 * Strategy: Last token is last_name, everything before is first_name.
 * 
 * @param fullName - Full name string to parse
 * @returns Object with first_name and last_name
 */
export function parseName(fullName: string | undefined): { first_name: string; last_name: string } {
  if (!fullName || !fullName.trim()) {
    return { first_name: '', last_name: '' };
  }
  
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    // Single name - treat as first name
    return { first_name: parts[0], last_name: '' };
  }
  
  // Last token = last_name, rest = first_name
  const last_name = parts[parts.length - 1];
  const first_name = parts.slice(0, -1).join(' ');
  return { first_name, last_name };
}

/**
 * Parse a phone list (comma/pipe/semicolon separated) and return the first valid phone.
 * Applies basic normalization (digits only, +1 prefix for US numbers).
 * 
 * @param phoneList - Comma/pipe/semicolon separated phone numbers
 * @returns First valid phone number, or empty string
 */
export function parsePhoneList(phoneList: string | undefined): string {
  if (!phoneList || !phoneList.trim()) {
    return '';
  }
  
  // Split on common delimiters
  const phones = phoneList.split(/[,|;]+/).map(p => p.trim()).filter(Boolean);
  
  for (const phone of phones) {
    // Extract digits only
    const digits = phone.replace(/\D/g, '');
    
    // Basic validation: US phone should have 10-11 digits
    if (digits.length === 10) {
      // Add +1 prefix for US
      return `+1${digits}`;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+${digits}`;
    }
    if (digits.length >= 10) {
      // International or other format - return as-is with + prefix
      return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
    }
  }
  
  // Fallback: return first phone as-is if no valid format found
  return phones[0] || '';
}

/**
 * Normalize a phone number to E.164 format.
 * Returns empty string if invalid.
 */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (digits.length >= 10) {
    return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  }
  return '';
}

/**
 * Result of parsing all available phones from a contact.
 */
export interface ParsedPhones {
  /** All valid phone numbers (normalized to E.164) */
  all: string[];
  /** Wireless/mobile phone numbers only */
  wireless: string[];
  /** Landline phone numbers only */
  landline: string[];
  /** Best phone number (first wireless, then first landline, then first other) */
  best: string;
}

/**
 * Parse ALL available phone numbers from a contact, categorized by type.
 * Collects phones from SKIPTRACE_WIRELESS_NUMBERS, SKIPTRACE_LANDLINE_NUMBERS,
 * SKIPTRACE_B2B_WIRELESS, SKIPTRACE_B2B_LANDLINE, mobile_phone, and phone fields.
 * 
 * @param contact - The AudienceLab contact
 * @param scope - Lead scope (commercial uses B2B fields)
 * @returns ParsedPhones with all phones categorized
 */
export function parseAllPhones(contact: AudienceLabContact, scope: LeadScope): ParsedPhones {
  const wireless: string[] = [];
  const landline: string[] = [];
  const other: string[] = [];
  const seenPhones = new Set<string>();

  // Helper to add phones from a comma/pipe/semicolon separated list
  const addPhones = (phoneList: string | undefined, category: 'wireless' | 'landline' | 'other') => {
    if (!phoneList || !phoneList.trim()) return;
    const phones = phoneList.split(/[,|;]+/).map(p => p.trim()).filter(Boolean);
    for (const phone of phones) {
      const normalized = normalizePhone(phone);
      if (normalized && !seenPhones.has(normalized)) {
        seenPhones.add(normalized);
        if (category === 'wireless') wireless.push(normalized);
        else if (category === 'landline') landline.push(normalized);
        else other.push(normalized);
      }
    }
  };

  if (scope === 'commercial') {
    // B2B phone fields
    addPhones(getField(contact, 'SKIPTRACE_B2B_WIRELESS'), 'wireless');
    addPhones(getField(contact, 'SKIPTRACE_B2B_WIRELESS_PHONE'), 'wireless');
    addPhones(getField(contact, 'SKIPTRACE_B2B_LANDLINE'), 'landline');
    addPhones(getField(contact, 'SKIPTRACE_B2B_LANDLINE_PHONE'), 'landline');
  } else {
    // B2C phone fields
    addPhones(getField(contact, 'SKIPTRACE_WIRELESS_NUMBERS'), 'wireless');
    addPhones(getField(contact, 'SKIPTRACE_LANDLINE_NUMBERS'), 'landline');
  }
  
  // Common fallback fields (categorized as 'other' since type is unknown)
  addPhones(getField(contact, 'mobile_phone'), 'wireless'); // mobile_phone is likely wireless
  addPhones(getField(contact, 'phone'), 'other');

  // Combine all phones (wireless first for best ordering)
  const all = [...wireless, ...landline, ...other];
  
  // Best phone: prefer wireless, then landline, then other
  const best = wireless[0] || landline[0] || other[0] || '';

  return { all, wireless, landline, best };
}

/**
 * Convert a MatchByTier to a numeric score.
 * - high (ADDRESS+EMAIL): 3
 * - medium (NAME+ADDRESS): 2
 * - low (other): 1
 * - null/undefined: 0 (no match data)
 */
export function tierToNumericScore(tier: MatchByTier | null | undefined): number {
  switch (tier) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

/**
 * Create an empty match score distribution.
 */
export function emptyMatchScoreDistribution(): MatchScoreDistribution {
  return { score0: 0, score1: 0, score2: 0, score3: 0 };
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
  /** Minimum match score (0-3) required. 0 = no filtering. */
  minMatchScore: number;
}

/**
 * Build recipe configuration based on scope and use case.
 * Implements AudienceLab Fields Guide recommendations:
 * - B2B Call: SKIPTRACE_B2B_WIRELESS/LANDLINE, prefer COMPANY_ADDRESS match
 * - B2B Email: BUSINESS_EMAIL with Valid(Esp) status, LAST_SEEN within 30 days
 * - B2C Call: SKIPTRACE_WIRELESS/LANDLINE, exclude DNC=Y, use SKIPTRACE_MATCH_BY
 * - B2C Email: PERSONAL_EMAIL with Valid(Esp) status, LAST_SEEN within 30 days
 * 
 * @param scope - Lead scope (residential/commercial/both)
 * @param useCase - Use case (call/email/both)
 * @param minMatchScoreOverride - Optional override for minMatchScore (default: 3 for call, 0 for others)
 */
export function buildRecipe(scope: LeadScope, useCase: UseCase, minMatchScoreOverride?: number): RecipeConfig {
  const isEmailUseCase = useCase === 'email';
  const isCallUseCase = useCase === 'call';
  const isB2C = scope === 'residential';
  
  // Default minMatchScore: 3 for call useCase (high tier only), 0 for others
  const defaultMinMatchScore = isCallUseCase ? 3 : 0;
  const minMatchScore = minMatchScoreOverride !== undefined ? minMatchScoreOverride : defaultMinMatchScore;
  
  return {
    requireEmailValidEsp: isEmailUseCase,
    requirePhone: isCallUseCase,
    excludeDnc: isB2C && (isCallUseCase || useCase === 'both'),
    freshnessDays: isEmailUseCase ? 30 : 0,
    useCase,
    minMatchScore,
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
 * Extended exclusion reasons for recipe engine.
 */
type ExclusionReason = 
  | 'dnc' 
  | 'invalid_email' 
  | 'invalid_email_esp' 
  | 'email_too_old' 
  | 'missing_phone' 
  | 'missing_contact'
  | 'low_match_score';

/**
 * Quality filter result for diagnostics with tier ranking.
 */
interface QualityFilterResult {
  lead: Lead | null;
  excluded: ExclusionReason | null;
  missingNameOrAddress: boolean;
  tier: MatchByTier;
  /** Numeric match score (0-3) for this contact */
  matchScore: number;
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
 * 
 * Checks ALL possible field sources including SKIPTRACE_* offline fields.
 */
export function computeContactsCoverage(contacts: AudienceLabContact[], scope: LeadScope): FieldCoverageBlock {
  if (contacts.length === 0) {
    return emptyFieldCoverageBlock();
  }

  const counts: Record<CoverageFieldName, number> = {
    first_name: 0, last_name: 0, address: 0, city: 0, state: 0, zip: 0, phone: 0, email: 0
  };

  for (const contact of contacts) {
    // Name: check SKIPTRACE_NAME (full name), SKIPTRACE_FIRST/LAST_NAME, and basic fields
    const hasFirstName = !!(getField(contact, 'SKIPTRACE_FIRST_NAME')
      || getField(contact, 'SKIPTRACE_NAME') // Full name can provide first name
      || getField(contact, 'FIRST_NAME')
      || getField(contact, 'first_name'));
    if (hasFirstName) counts.first_name++;
    
    const hasLastName = !!(getField(contact, 'SKIPTRACE_LAST_NAME')
      || getField(contact, 'SKIPTRACE_NAME') // Full name can provide last name
      || getField(contact, 'LAST_NAME')
      || getField(contact, 'last_name'));
    if (hasLastName) counts.last_name++;
    
    // Address: check SKIPTRACE_ADDRESS first, then online fields
    const hasAddress = !!(getField(contact, 'SKIPTRACE_ADDRESS')
      || getField(contact, 'address')
      || getField(contact, 'street_address')
      || (scope === 'commercial' && getField(contact, 'COMPANY_ADDRESS')));
    if (hasAddress) counts.address++;
    
    // City: check SKIPTRACE_CITY first
    const hasCity = !!(getField(contact, 'SKIPTRACE_CITY') || getField(contact, 'city'));
    if (hasCity) counts.city++;
    
    // State: check SKIPTRACE_STATE first
    const hasState = !!(getField(contact, 'SKIPTRACE_STATE') || getField(contact, 'state'));
    if (hasState) counts.state++;
    
    // ZIP: check SKIPTRACE_ZIP first
    const hasZip = !!(getField(contact, 'SKIPTRACE_ZIP')
      || getField(contact, 'zip')
      || getField(contact, 'postal_code'));
    if (hasZip) counts.zip++;
    
    // Phone: check all possible sources based on scope
    const hasPhone = scope === 'commercial'
      ? !!(getField(contact, 'SKIPTRACE_B2B_WIRELESS')
          || getField(contact, 'SKIPTRACE_B2B_WIRELESS_PHONE')
          || getField(contact, 'SKIPTRACE_B2B_LANDLINE')
          || getField(contact, 'SKIPTRACE_B2B_LANDLINE_PHONE')
          || getField(contact, 'mobile_phone')
          || getField(contact, 'phone'))
      : !!(getField(contact, 'SKIPTRACE_WIRELESS_NUMBERS')
          || getField(contact, 'SKIPTRACE_LANDLINE_NUMBERS')
          || getField(contact, 'mobile_phone')
          || getField(contact, 'phone'));
    if (hasPhone) counts.phone++;
    
    // Email: check validated email fields based on scope
    const hasEmail = scope === 'commercial'
      ? !!(getField(contact, 'BUSINESS_EMAIL') || getField(contact, 'email'))
      : !!(getField(contact, 'PERSONAL_EMAIL') || getField(contact, 'email'));
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
 *   - 'call': require phone, exclude DNC for B2C, filter by minMatchScore, rank by match_by tier
 *   - 'email': require Valid(Esp) email, check LAST_SEEN freshness
 *   - 'both': either phone or email, best of both rules
 * 
 * @param contact - AudienceLab contact to map
 * @param input - Generate input with scope, useCase, and optional minMatchScore
 * @param index - Contact index (used for 'both' scope alternation)
 * @param minMatchScoreOverride - Optional override for minMatchScore filter
 */
export function mapAudienceLabContactToLead(
  contact: AudienceLabContact,
  input: GenerateInput,
  index: number,
  minMatchScoreOverride?: number
): QualityFilterResult {
  const useCase: UseCase = input.useCase || 'both';
  
  // Determine effective scope for this contact
  let effectiveScope: LeadScope;
  if (input.scope === 'both') {
    effectiveScope = index % 2 === 0 ? 'residential' : 'commercial';
  } else {
    effectiveScope = input.scope;
  }

  // Build recipe for this scope + useCase (with optional minMatchScore override)
  const recipe = buildRecipe(effectiveScope, useCase, minMatchScoreOverride);
  
  // Compute match-by accuracy tier and numeric score
  const tier = evaluateMatchByTier(contact, effectiveScope);
  const matchScore = tierToNumericScore(tier);

  // Check minMatchScore filter (applies before other filters to allow accurate diagnostics)
  if (recipe.minMatchScore > 0 && matchScore < recipe.minMatchScore) {
    return { lead: null, excluded: 'low_match_score', missingNameOrAddress: false, tier, matchScore };
  }

  // Check DNC exclusion (B2C call/both only per recipe)
  if (recipe.excludeDnc && contact.DNC?.toUpperCase() === 'Y') {
    return { lead: null, excluded: 'dnc', missingNameOrAddress: false, tier, matchScore };
  }

  // Select quality email with enhanced validation info
  const emailResult = selectQualityEmail(contact, effectiveScope);
  const { email, isValid: emailValid, isValidEsp } = emailResult;
  
  // For 'email' useCase: require Valid(Esp) email per recipe
  if (recipe.requireEmailValidEsp) {
    if (!email) {
      return { lead: null, excluded: 'invalid_email', missingNameOrAddress: false, tier, matchScore };
    }
    if (!isValidEsp) {
      return { lead: null, excluded: 'invalid_email_esp', missingNameOrAddress: false, tier, matchScore };
    }
    // Check LAST_SEEN freshness for email use case
    if (!isWithinFreshnessWindow(contact.LAST_SEEN, recipe.freshnessDays)) {
      return { lead: null, excluded: 'email_too_old', missingNameOrAddress: false, tier, matchScore };
    }
  } else {
    // For 'call' and 'both': exclude contacts with explicitly invalid emails (but allow missing)
    if (email && !emailValid) {
      return { lead: null, excluded: 'invalid_email', missingNameOrAddress: false, tier, matchScore };
    }
  }

  // Parse ALL available phones (for dialer-friendly export)
  const parsedPhones = parseAllPhones(contact, effectiveScope);

  // For 'call' useCase: require phone present per recipe
  if (recipe.requirePhone && !parsedPhones.best) {
    return { lead: null, excluded: 'missing_phone', missingNameOrAddress: false, tier, matchScore };
  }

  // For 'both' useCase: need at least phone or email
  if (useCase === 'both' && !parsedPhones.best && !email) {
    return { lead: null, excluded: 'missing_contact', missingNameOrAddress: false, tier, matchScore };
  }

  // ==========================================================================
  // FIELD MAPPING: Use SKIPTRACE_* (offline) fields first, then online fallbacks
  // ==========================================================================
  
  // Name: SKIPTRACE_NAME (full name) > SKIPTRACE_FIRST/LAST_NAME > FIRST_NAME/LAST_NAME > first_name/last_name
  let first_name = '';
  let last_name = '';
  
  const skiptraceFullName = getField(contact, 'SKIPTRACE_NAME');
  if (skiptraceFullName) {
    // Parse full name into first/last
    const parsed = parseName(skiptraceFullName);
    first_name = parsed.first_name;
    last_name = parsed.last_name;
  } else {
    // Try individual SKIPTRACE fields, then uppercase variants, then lowercase
    first_name = getField(contact, 'SKIPTRACE_FIRST_NAME')
      || getField(contact, 'FIRST_NAME')
      || getField(contact, 'first_name')
      || '';
    last_name = getField(contact, 'SKIPTRACE_LAST_NAME')
      || getField(contact, 'LAST_NAME')
      || getField(contact, 'last_name')
      || '';
  }
  
  // Address: SKIPTRACE_ADDRESS > COMPANY_ADDRESS (B2B) > address > street_address
  let address = '';
  if (effectiveScope === 'commercial') {
    address = getField(contact, 'SKIPTRACE_ADDRESS')
      || getField(contact, 'COMPANY_ADDRESS')
      || getField(contact, 'address')
      || getField(contact, 'street_address')
      || '';
  } else {
    address = getField(contact, 'SKIPTRACE_ADDRESS')
      || getField(contact, 'address')
      || getField(contact, 'street_address')
      || '';
  }
  
  // City: SKIPTRACE_CITY > city
  const city = getField(contact, 'SKIPTRACE_CITY')
    || getField(contact, 'city')
    || '';
  
  // State: SKIPTRACE_STATE > state
  const state = getField(contact, 'SKIPTRACE_STATE')
    || getField(contact, 'state')
    || '';
  
  // ZIP: SKIPTRACE_ZIP > zip > postal_code
  const zip = getField(contact, 'SKIPTRACE_ZIP')
    || getField(contact, 'zip')
    || getField(contact, 'postal_code')
    || '';

  // Check for missing name or address (for quality summary, not exclusion)
  const hasName = !!(first_name || last_name);
  const hasAddress = !!address;
  const missingNameOrAddress = !hasName || !hasAddress;

  const lead: Lead = {
    first_name,
    last_name,
    address,
    city,
    state,
    zip,
    phone: parsedPhones.best,
    email,
    lead_type: effectiveScope,
    tags: input.leadRequest,
    source: 'audiencelab',
    // New dialer-friendly phone fields
    best_phone: parsedPhones.best,
    phones_all: parsedPhones.all.join('|'),
    wireless_phones: parsedPhones.wireless.join('|'),
    landline_phones: parsedPhones.landline.join('|'),
    match_score: matchScore,
  };

  return { lead, excluded: null, missingNameOrAddress, tier, matchScore };
}

/**
 * Configuration constants for AudienceLab payload building
 */
const PAYLOAD_DEFAULTS = {
  MIN_SIZE: 1,
  MAX_SIZE: 1000,
  DEFAULT_SIZE: 200,
  MIN_MATCH_SCORE_CALL: 3,
  MIN_MATCH_SCORE_EMAIL: 0, // Email doesn't require match score by default
  AUDIENCE_NAME_MAX_LENGTH: 50,
} as const;

/**
 * Map our scope ('residential'/'commercial') to AudienceLab's persona_type
 */
function mapScopeToPersonaType(scope: LeadScope): 'B2C' | 'B2B' {
  return scope === 'commercial' ? 'B2B' : 'B2C';
}

/**
 * Build contact filters based on use case (call vs email)
 */
function buildContactFilters(useCase: UseCase, minMatchScoreOverride?: number): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  
  if (useCase === 'call') {
    // For call use case:
    // - Require skip trace wireless phone present
    // - DNC must be empty (not on Do-Not-Call list)
    // - Match score >= minMatchScore (default 3 for call)
    const effectiveMinScore = minMatchScoreOverride ?? PAYLOAD_DEFAULTS.MIN_MATCH_SCORE_CALL;
    filters.phone_required = true;
    filters.skip_trace_phone_required = true;
    filters.wireless_phone_required = true; // Prioritize mobile for calling
    filters.dnc_status = 'clean'; // Not on Do-Not-Call list
    filters.min_match_score = effectiveMinScore;
  } else if (useCase === 'email') {
    // For email use case:
    // - Require valid email present
    // - Email validation status should be valid
    filters.email_required = true;
    filters.email_validation_status = 'valid';
    // Match score less critical for email, but can still apply if specified
    if (minMatchScoreOverride !== undefined) {
      filters.min_match_score = minMatchScoreOverride;
    }
  }
  
  return filters;
}

/**
 * Build intent/keyword filters for audience targeting
 */
function buildIntentFilters(leadRequest: string): Record<string, unknown> {
  return {
    // Keywords for intent matching
    keywords: leadRequest,
    // Intent signals - target active/recent intent
    intent_strength: ['high', 'medium'], // Filter for meaningful intent
  };
}

/**
 * Build geographic filters from ZIP codes
 */
function buildGeoFilters(zips: string[]): Record<string, unknown> {
  // Build zip code filter with the full list
  const geoFilters: Record<string, unknown> = {
    zip_codes: zips,
  };
  
  // Also extract city/state hints for better targeting (up to 10 zips for lookup)
  const locations: Array<{ city?: string; state?: string; zip?: string }> = [];
  for (const zip of zips.slice(0, 10)) {
    const location = lookupZipLocation(zip);
    if (location) {
      locations.push({ city: location.city, state: location.state, zip });
    } else {
      locations.push({ zip });
    }
  }
  
  if (locations.length > 0) {
    geoFilters.locations = locations;
  }
  
  return geoFilters;
}

/**
 * Build audience creation payload with full AudienceLab filtering.
 * 
 * This function builds a comprehensive payload including:
 * - Intent/keyword targeting based on lead request
 * - B2B/B2C persona type based on scope
 * - Geographic targeting via ZIP codes
 * - Contact quality filters (phone, email, DNC, match score)
 * - Requested audience size
 */
export function buildAudiencePayload(input: GenerateInput): Record<string, unknown> {
  // Determine requested size (default 200, max 1000)
  const requestedCount = (input as { requestedCount?: number }).requestedCount;
  const size = Math.max(
    PAYLOAD_DEFAULTS.MIN_SIZE,
    Math.min(requestedCount ?? PAYLOAD_DEFAULTS.DEFAULT_SIZE, PAYLOAD_DEFAULTS.MAX_SIZE)
  );
  
  // Get useCase and minMatchScore from input
  const useCase: UseCase = (input as { useCase?: UseCase }).useCase ?? 'call';
  const minMatchScore = (input as { minMatchScore?: number }).minMatchScore;
  
  // Build structured filters
  const intentFilters = buildIntentFilters(input.leadRequest);
  const geoFilters = buildGeoFilters(input.zips);
  const contactFilters = buildContactFilters(useCase, minMatchScore);
  
  // Build the full payload
  const payload: Record<string, unknown> = {
    // Audience metadata
    name: `Lead Request: ${input.leadRequest.slice(0, PAYLOAD_DEFAULTS.AUDIENCE_NAME_MAX_LENGTH)}`,
    description: input.leadRequest,
    
    // Persona type (B2B for commercial, B2C for residential)
    persona_type: mapScopeToPersonaType(input.scope),
    
    // Size - how many leads to target
    size,
    
    // Filters object combines all filter types
    filters: {
      // Intent targeting
      ...intentFilters,
      
      // Geographic targeting
      ...geoFilters,
      
      // Contact quality requirements
      ...contactFilters,
    },
  };
  
  return payload;
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

    // Step 2: Fetch audience members with proper pagination
    // Use requestedCount (default 200, max 1000) instead of hardcoded 50
    const requestedCount = (input as { requestedCount?: number }).requestedCount ?? PAYLOAD_DEFAULTS.DEFAULT_SIZE;
    const maxLeads = Math.min(requestedCount, PAYLOAD_DEFAULTS.MAX_SIZE);
    
    const allContacts: AudienceLabContact[] = [];
    let page = 1;
    const pageSize = 100; // Fetch in larger batches for efficiency
    const maxPages = Math.ceil(maxLeads / pageSize) + 5; // Safety margin for filtering

    while (allContacts.length < maxLeads * 1.5) { // Fetch extra to account for filtering
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
        break; // No more data available
      }

      allContacts.push(...contacts);
      
      // Check if we've exhausted available data
      if (contacts.length < pageSize) {
        break;
      }
      
      page++;
      
      // Safety limit on pagination (based on requested size)
      if (page > maxPages) {
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
    // Get minMatchScore from input if available (via ValidatedPayload extension)
    const minMatchScore = (input as { minMatchScore?: number }).minMatchScore;
    
    const diagnostics: LeadQualityDiagnostics = {
      totalFetched: allContacts.length,
      kept: 0,
      filteredMissingPhone: 0,
      filteredInvalidEmail: 0,
      filteredInvalidEmailEsp: 0,
      filteredEmailTooOld: 0,
      filteredDnc: 0,
      filteredLowMatchScore: 0,
      missingNameOrAddressCount: 0,
      matchByTier: { high: 0, medium: 0, low: 0 },
      matchScoreDistribution: emptyMatchScoreDistribution(),
    };
    
    // First pass: filter and collect leads with their tiers
    const leadsWithTier: Array<{ lead: Lead; tier: MatchByTier; missingNameOrAddress: boolean }> = [];
    for (let i = 0; i < allContacts.length; i++) {
      const result = mapAudienceLabContactToLead(allContacts[i], input, i, minMatchScore);
      
      // Track match score distribution for ALL contacts (before filtering)
      const scoreKey = `score${result.matchScore}` as keyof typeof diagnostics.matchScoreDistribution;
      diagnostics.matchScoreDistribution[scoreKey]++;
      
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
          case 'low_match_score': diagnostics.filteredLowMatchScore++; break;
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

  // Use requestedCount (default 200, max 1000) for pagination
  const requestedCount = (input as { requestedCount?: number }).requestedCount ?? PAYLOAD_DEFAULTS.DEFAULT_SIZE;
  const maxLeads = Math.min(requestedCount, PAYLOAD_DEFAULTS.MAX_SIZE);
  
  const allContacts: AudienceLabContact[] = [];
  let page = 1;
  const pageSize = 100; // Fetch in larger batches for efficiency
  const maxPages = Math.ceil(maxLeads / pageSize) + 5; // Safety margin

  try {
    while (allContacts.length < maxLeads * 1.5) { // Fetch extra to account for filtering
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
      if (page > maxPages) break;
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
    // Get minMatchScore from input if available
    const minMatchScore = (input as { minMatchScore?: number }).minMatchScore;
    
    const diagnostics: LeadQualityDiagnostics = {
      totalFetched: allContacts.length,
      kept: 0,
      filteredMissingPhone: 0,
      filteredInvalidEmail: 0,
      filteredInvalidEmailEsp: 0,
      filteredEmailTooOld: 0,
      filteredDnc: 0,
      filteredLowMatchScore: 0,
      missingNameOrAddressCount: 0,
      matchByTier: { high: 0, medium: 0, low: 0 },
      matchScoreDistribution: emptyMatchScoreDistribution(),
    };
    
    // First pass: filter and collect leads with their tiers
    const leadsWithTier: Array<{ lead: Lead; tier: MatchByTier; missingNameOrAddress: boolean }> = [];
    for (let i = 0; i < allContacts.length; i++) {
      const result = mapAudienceLabContactToLead(allContacts[i], input, i, minMatchScore);
      
      // Track match score distribution for ALL contacts
      const scoreKey = `score${result.matchScore}` as keyof typeof diagnostics.matchScoreDistribution;
      diagnostics.matchScoreDistribution[scoreKey]++;
      
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
          case 'low_match_score': diagnostics.filteredLowMatchScore++; break;
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
