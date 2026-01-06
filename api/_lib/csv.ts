import type { Lead } from './types.js';

const HEADERS = ['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'lead_type', 'tags', 'source'] as const;

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
