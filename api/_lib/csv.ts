import type { Lead } from './types.js';

/**
 * CSV column headers for lead export.
 * 
 * New dialer-friendly columns added:
 * - best_phone: Same as phone, for convenience
 * - phones_all: All available phones (pipe-separated)
 * - wireless_phones: Wireless/mobile phones only (pipe-separated)
 * - landline_phones: Landline phones only (pipe-separated)
 * - match_score: Quality score 0-3 (3=high, 2=medium, 1=low, 0=none)
 */
const HEADERS = [
  'first_name', 
  'last_name', 
  'address', 
  'city', 
  'state', 
  'zip', 
  'phone', 
  'email', 
  'lead_type', 
  'tags', 
  'source',
  // New dialer-friendly columns
  'best_phone',
  'phones_all',
  'wireless_phones',
  'landline_phones',
  'match_score',
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
