import type { Lead } from './types.js';

/**
 * CSV column headers for lead export.
 *
 * Rich export schema with quality metrics and contact details:
 * - Core identity: first_name, last_name
 * - Address: address, city, state, zip
 * - Contact: phone, email, best_phone, phones_all, wireless_phones, landline_phones
 * - Quality metrics: match_score, quality_score, quality_tier
 * - Status: dnc_status, email_validation_status
 * - Metadata: lead_type, tags, source
 *
 * Columns are ordered for dialer import convenience (name/contact first).
 */
const HEADERS = [
  // Identity
  'first_name',
  'last_name',
  // Address
  'address',
  'city',
  'state',
  'zip',
  // Primary contact
  'phone',
  'email',
  // Phone details (dialer-friendly)
  'best_phone',
  'wireless_phones',
  'landline_phones',
  'phones_all',
  // Quality metrics
  'quality_score',
  'quality_tier',
  'match_score',
  // Status flags
  'dnc_status',
  'email_validation_status',
  // Metadata
  'lead_type',
  'tags',
  'source',
] as const;

/**
 * Characters that trigger formula execution in Excel/Sheets.
 * Must be prefixed with single quote to neutralize.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escape a value for CSV output.
 * - Prefixes formula-injection characters with single quote
 * - Escapes double quotes by doubling them
 * - Wraps in double quotes
 */
export function escapeCsv(value: unknown): string {
  let str = String(value ?? '');
  
  // Neutralize formula injection: prefix dangerous chars with single quote
  if (str.length > 0 && FORMULA_PREFIXES.includes(str[0])) {
    str = "'" + str;
  }
  
  // Escape double quotes by doubling them
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function leadsToCsv(leads: Lead[]): string {
  const lines: string[] = [];
  lines.push(HEADERS.join(','));
  for (const lead of leads) {
    const row = HEADERS.map((h) => escapeCsv(lead[h])).join(',');
    lines.push(row);
  }
  return lines.join('\n');
}
