import { describe, it, expect } from 'vitest';
import { escapeCsv, leadsToCsv } from '../../../api/_lib/csv.js';

describe('escapeCsv', () => {
  describe('formula injection prevention', () => {
    it('prefixes = with single quote', () => {
      expect(escapeCsv('=HYPERLINK("http://evil.com","Click")')).toBe(`"'=HYPERLINK(""http://evil.com"",""Click"")"`);
    });

    it('prefixes + with single quote', () => {
      expect(escapeCsv('+1234567890')).toBe(`"'+1234567890"`);
    });

    it('prefixes - with single quote', () => {
      expect(escapeCsv('-2+2*cmd|calc')).toBe(`"'-2+2*cmd|calc"`);
    });

    it('prefixes @ with single quote', () => {
      expect(escapeCsv('@SUM(A1:A10)')).toBe(`"'@SUM(A1:A10)"`);
    });

    it('prefixes tab with single quote', () => {
      expect(escapeCsv('\t=cmd')).toBe(`"'\t=cmd"`);
    });

    it('prefixes carriage return with single quote', () => {
      expect(escapeCsv('\r=formula')).toBe(`"'\r=formula"`);
    });
  });

  describe('safe values', () => {
    it('does not prefix normal text', () => {
      expect(escapeCsv('John Doe')).toBe('"John Doe"');
    });

    it('handles empty string', () => {
      expect(escapeCsv('')).toBe('""');
    });

    it('handles null/undefined', () => {
      expect(escapeCsv(null)).toBe('""');
      expect(escapeCsv(undefined)).toBe('""');
    });

    it('handles numbers', () => {
      expect(escapeCsv(12345)).toBe('"12345"');
    });

    it('does not prefix email addresses', () => {
      expect(escapeCsv('test@example.com')).toBe('"test@example.com"');
    });

    it('does not prefix phone numbers', () => {
      expect(escapeCsv('(305) 555-1234')).toBe('"(305) 555-1234"');
    });
  });

  describe('quote escaping', () => {
    it('escapes double quotes by doubling', () => {
      expect(escapeCsv('Say "Hello"')).toBe('"Say ""Hello"""');
    });

    it('combines formula prevention with quote escaping', () => {
      expect(escapeCsv('=HYPERLINK("http://evil.com")')).toBe(`"'=HYPERLINK(""http://evil.com"")"`);
    });
  });
});

describe('leadsToCsv', () => {
  it('generates CSV with header row', () => {
    const leads = [{
      first_name: 'John',
      last_name: 'Doe',
      address: '123 Main St',
      city: 'Miami',
      state: 'FL',
      zip: '33101',
      phone: '+13055551234',
      email: 'john@example.com',
      lead_type: 'residential',
      tags: 'roofing',
      source: 'audiencelab',
      // New dialer-friendly fields
      best_phone: '+13055551234',
      phones_all: '+13055551234|+13055552222',
      wireless_phones: '+13055551234',
      landline_phones: '+13055552222',
      match_score: 3,
    }];

    const csv = leadsToCsv(leads);
    const lines = csv.split('\n');

    // Updated header includes new columns
    expect(lines[0]).toBe('first_name,last_name,address,city,state,zip,phone,email,lead_type,tags,source,best_phone,phones_all,wireless_phones,landline_phones,match_score');
    expect(lines[1]).toContain('"John"');
    expect(lines[1]).toContain('"Doe"');
    // Verify new columns are in the data row
    // Note: phones starting with + are prefixed with ' for formula injection prevention
    expect(lines[1]).toContain(`"'+13055551234|+13055552222"`); // phones_all (prefixed with ')
    expect(lines[1]).toContain('"3"'); // match_score
  });

  it('sanitizes formula injection in lead data', () => {
    const leads = [{
      first_name: '=EVIL',
      last_name: '+FORMULA',
      address: '-ATTACK',
      city: '@MALICIOUS',
      state: 'FL',
      zip: '33101',
      phone: '+13055551234',
      email: 'test@example.com',
      lead_type: 'residential',
      tags: 'normal',
      source: 'test',
      // New dialer-friendly fields
      best_phone: '+13055551234',
      phones_all: '+13055551234',
      wireless_phones: '+13055551234',
      landline_phones: '',
      match_score: 2,
    }];

    const csv = leadsToCsv(leads);
    
    // Each dangerous value should be prefixed with single quote
    expect(csv).toContain(`"'=EVIL"`);
    expect(csv).toContain(`"'+FORMULA"`);
    expect(csv).toContain(`"'-ATTACK"`);
    expect(csv).toContain(`"'@MALICIOUS"`);
  });
});
