import type { Lead } from './types.js';

const HEADERS = ['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'lead_type', 'tags', 'source'] as const;

function escapeCsv(value: unknown): string {
  const str = String(value ?? '');
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
