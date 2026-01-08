import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCallSuppressStates,
  filterLeadsByStateCompliance,
  calculateBackoffSeconds,
  hasExceededMaxAttempts,
  MAX_POLL_ATTEMPTS,
  BACKOFF_SEQUENCE,
} from '../../../api/_lib/compliance';

describe('getCallSuppressStates', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default ["TX"] when CALL_SUPPRESS_STATES is not set', () => {
    delete process.env.CALL_SUPPRESS_STATES;
    expect(getCallSuppressStates()).toEqual(['TX']);
  });

  it('returns empty array when CALL_SUPPRESS_STATES is empty string', () => {
    process.env.CALL_SUPPRESS_STATES = '';
    expect(getCallSuppressStates()).toEqual([]);
  });

  it('returns empty array when CALL_SUPPRESS_STATES is "none"', () => {
    process.env.CALL_SUPPRESS_STATES = 'none';
    expect(getCallSuppressStates()).toEqual([]);
  });

  it('returns empty array when CALL_SUPPRESS_STATES is "NONE" (case-insensitive)', () => {
    process.env.CALL_SUPPRESS_STATES = 'NONE';
    expect(getCallSuppressStates()).toEqual([]);
  });

  it('parses single state', () => {
    process.env.CALL_SUPPRESS_STATES = 'CA';
    expect(getCallSuppressStates()).toEqual(['CA']);
  });

  it('parses multiple comma-separated states', () => {
    process.env.CALL_SUPPRESS_STATES = 'TX,CA,NY';
    expect(getCallSuppressStates()).toEqual(['TX', 'CA', 'NY']);
  });

  it('uppercases and trims states', () => {
    process.env.CALL_SUPPRESS_STATES = ' tx , ca , ny ';
    expect(getCallSuppressStates()).toEqual(['TX', 'CA', 'NY']);
  });

  it('filters out empty segments', () => {
    process.env.CALL_SUPPRESS_STATES = 'TX,,CA,';
    expect(getCallSuppressStates()).toEqual(['TX', 'CA']);
  });
});

describe('filterLeadsByStateCompliance', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Default to TX suppression for tests
    process.env.CALL_SUPPRESS_STATES = 'TX';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeLead = (state: string) => ({
    first_name: 'John',
    last_name: 'Doe',
    address: '123 Main St',
    city: 'Anytown',
    state,
    zip: '12345',
    phone: '555-1234',
    email: 'john@example.com',
    lead_type: 'residential' as const,
    tags: '',
    source: 'audiencelab',
    best_phone: '555-1234',
    phones_all: '555-1234',
    wireless_phones: '555-1234',
    landline_phones: '',
    match_score: 3,
    quality_score: 75,
    quality_tier: 'balanced' as const,
    dnc_status: 'clean',
    email_validation_status: '',
  });

  it('does not filter for email useCase', () => {
    const leads = [makeLead('TX'), makeLead('CA')];
    const result = filterLeadsByStateCompliance(leads, 'email');
    
    expect(result.filteredLeads).toHaveLength(2);
    expect(result.suppressedCount).toBe(0);
    expect(result.suppressedStates).toEqual([]);
  });

  it('does not filter for both useCase', () => {
    const leads = [makeLead('TX'), makeLead('CA')];
    const result = filterLeadsByStateCompliance(leads, 'both');
    
    expect(result.filteredLeads).toHaveLength(2);
    expect(result.suppressedCount).toBe(0);
  });

  it('filters TX leads for call useCase with default suppression', () => {
    const leads = [makeLead('TX'), makeLead('CA'), makeLead('NY'), makeLead('TX')];
    const result = filterLeadsByStateCompliance(leads, 'call');
    
    expect(result.filteredLeads).toHaveLength(2);
    expect(result.filteredLeads.map(l => l.state)).toEqual(['CA', 'NY']);
    expect(result.suppressedCount).toBe(2);
    expect(result.suppressedStates).toEqual(['TX']);
  });

  it('filters multiple states when configured', () => {
    process.env.CALL_SUPPRESS_STATES = 'TX,CA';
    const leads = [makeLead('TX'), makeLead('CA'), makeLead('NY'), makeLead('FL')];
    const result = filterLeadsByStateCompliance(leads, 'call');
    
    expect(result.filteredLeads).toHaveLength(2);
    expect(result.filteredLeads.map(l => l.state)).toEqual(['NY', 'FL']);
    expect(result.suppressedCount).toBe(2);
    expect(result.suppressedStates).toEqual(['TX', 'CA']);
  });

  it('returns all leads when suppression is disabled', () => {
    process.env.CALL_SUPPRESS_STATES = 'none';
    const leads = [makeLead('TX'), makeLead('CA')];
    const result = filterLeadsByStateCompliance(leads, 'call');
    
    expect(result.filteredLeads).toHaveLength(2);
    expect(result.suppressedCount).toBe(0);
    expect(result.suppressedStates).toEqual([]);
  });

  it('handles leads with missing state field', () => {
    const leadsWithMissingState = [
      makeLead('TX'),
      { ...makeLead('CA'), state: undefined as unknown as string },
      { ...makeLead('NY'), state: '' },
    ];
    const result = filterLeadsByStateCompliance(leadsWithMissingState, 'call');
    
    // TX is filtered, leads without state are kept
    expect(result.filteredLeads).toHaveLength(2);
    expect(result.suppressedCount).toBe(1);
  });

  it('is case-insensitive for state matching', () => {
    const leads = [
      { ...makeLead('TX'), state: 'tx' },
      { ...makeLead('TX'), state: 'Tx' },
      makeLead('CA'),
    ];
    const result = filterLeadsByStateCompliance(leads, 'call');
    
    expect(result.filteredLeads).toHaveLength(1);
    expect(result.suppressedCount).toBe(2);
  });

  it('returns unique suppressed states', () => {
    const leads = [makeLead('TX'), makeLead('TX'), makeLead('TX')];
    const result = filterLeadsByStateCompliance(leads, 'call');
    
    expect(result.suppressedStates).toEqual(['TX']);
    expect(result.suppressedCount).toBe(3);
  });
});

describe('calculateBackoffSeconds', () => {
  it('returns sequence values for attempts 1-8', () => {
    expect(calculateBackoffSeconds(1)).toBe(3);
    expect(calculateBackoffSeconds(2)).toBe(5);
    expect(calculateBackoffSeconds(3)).toBe(8);
    expect(calculateBackoffSeconds(4)).toBe(13);
    expect(calculateBackoffSeconds(5)).toBe(21);
    expect(calculateBackoffSeconds(6)).toBe(34);
    expect(calculateBackoffSeconds(7)).toBe(55);
    expect(calculateBackoffSeconds(8)).toBe(60);
  });

  it('caps at 60 seconds for attempts beyond sequence', () => {
    expect(calculateBackoffSeconds(9)).toBe(60);
    expect(calculateBackoffSeconds(10)).toBe(60);
    expect(calculateBackoffSeconds(30)).toBe(60);
    expect(calculateBackoffSeconds(100)).toBe(60);
  });

  it('returns first value for attempt 0', () => {
    expect(calculateBackoffSeconds(0)).toBe(3);
  });

  it('handles negative attempts gracefully', () => {
    expect(calculateBackoffSeconds(-1)).toBe(3);
  });

  it('backoff sequence follows modified Fibonacci pattern', () => {
    // 3, 5, 8, 13, 21, 34, 55, 60 (capped)
    expect(BACKOFF_SEQUENCE).toEqual([3, 5, 8, 13, 21, 34, 55, 60]);
  });
});

describe('hasExceededMaxAttempts', () => {
  it('returns false for attempts below max', () => {
    expect(hasExceededMaxAttempts(0)).toBe(false);
    expect(hasExceededMaxAttempts(1)).toBe(false);
    expect(hasExceededMaxAttempts(29)).toBe(false);
  });

  it('returns true for attempts at or above max', () => {
    expect(hasExceededMaxAttempts(30)).toBe(true);
    expect(hasExceededMaxAttempts(31)).toBe(true);
    expect(hasExceededMaxAttempts(100)).toBe(true);
  });

  it('MAX_POLL_ATTEMPTS is 30', () => {
    expect(MAX_POLL_ATTEMPTS).toBe(30);
  });
});

describe('integration: total polling time estimation', () => {
  it('estimates reasonable total polling time for max attempts', () => {
    // Calculate total time if all 30 attempts are used
    let totalSeconds = 0;
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      totalSeconds += calculateBackoffSeconds(attempt);
    }
    
    // First 8 attempts: 3+5+8+13+21+34+55+60 = 199 seconds
    // Remaining 22 attempts: 22 * 60 = 1320 seconds
    // Total: ~1519 seconds (~25 minutes)
    expect(totalSeconds).toBeGreaterThan(20 * 60); // > 20 minutes
    expect(totalSeconds).toBeLessThan(30 * 60);    // < 30 minutes
  });
});
