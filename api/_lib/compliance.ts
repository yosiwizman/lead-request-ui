/**
 * Compliance module for lead generation.
 * 
 * Implements guardrails for calling compliance, including state-level suppression.
 * 
 * IMPORTANT: This is a technical guardrail only. Users remain responsible for
 * ensuring compliance with all applicable telemarketing laws and regulations.
 */

import type { Lead, UseCase } from './types.js';

/**
 * Default states to suppress for CALL exports.
 * TX (Texas) has strict telemarketing regulations.
 */
const DEFAULT_SUPPRESS_STATES = ['TX'];

/**
 * Maximum number of poll attempts before marking as failed.
 */
export const MAX_POLL_ATTEMPTS = 30;

/**
 * Fibonacci-based backoff sequence (seconds).
 * Capped at 60 seconds.
 */
export const BACKOFF_SEQUENCE = [3, 5, 8, 13, 21, 34, 55, 60];

/**
 * Get the list of states to suppress for CALL exports.
 * Reads from CALL_SUPPRESS_STATES env var (comma-separated).
 * Defaults to ['TX'] if not set.
 * 
 * To disable suppression entirely, set CALL_SUPPRESS_STATES="" or CALL_SUPPRESS_STATES="none"
 */
export function getCallSuppressStates(): string[] {
  const envValue = process.env.CALL_SUPPRESS_STATES;
  
  // If explicitly set to empty string, disable suppression
  if (envValue === '') {
    return [];
  }
  
  // If not set, use defaults
  if (envValue === undefined || envValue === null) {
    return DEFAULT_SUPPRESS_STATES;
  }
  
  // Handle "none" keyword (case-insensitive) to disable suppression
  if (envValue.trim().toLowerCase() === 'none') {
    return [];
  }
  
  // Parse comma-separated list, normalize to uppercase
  return envValue
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0);
}

/**
 * Result of compliance filtering.
 */
export interface ComplianceFilterResult {
  /** Leads that passed compliance filtering */
  filteredLeads: Lead[];
  /** Count of suppressed leads */
  suppressedCount: number;
  /** States that were suppressed */
  suppressedStates: string[];
}

/**
 * Filter leads by state for compliance.
 * 
 * Only applies to CALL useCase. Email exports are not affected.
 * 
 * @param leads - Array of leads to filter
 * @param useCase - The use case (call, email, or both)
 * @param customSuppressStates - Optional override for suppress states (defaults to env/config)
 * @returns Filtered leads and suppression statistics
 */
export function filterLeadsByStateCompliance(
  leads: Lead[],
  useCase: UseCase,
  customSuppressStates?: string[]
): ComplianceFilterResult {
  // Only apply suppression for CALL exports
  if (useCase !== 'call') {
    return {
      filteredLeads: leads,
      suppressedCount: 0,
      suppressedStates: [],
    };
  }
  
  const suppressStates = customSuppressStates ?? getCallSuppressStates();
  
  // If no states to suppress, return all leads
  if (suppressStates.length === 0) {
    return {
      filteredLeads: leads,
      suppressedCount: 0,
      suppressedStates: [],
    };
  }
  
  // Create a Set for efficient lookup (uppercase for case-insensitive matching)
  const suppressSet = new Set(suppressStates.map(s => s.toUpperCase()));
  
  const filtered: Lead[] = [];
  const actualSuppressedStates = new Set<string>();
  let suppressedCount = 0;
  
  for (const lead of leads) {
    const state = (lead.state || '').toUpperCase().trim();
    
    if (state && suppressSet.has(state)) {
      suppressedCount++;
      actualSuppressedStates.add(state);
    } else {
      filtered.push(lead);
    }
  }
  
  return {
    filteredLeads: filtered,
    suppressedCount,
    suppressedStates: Array.from(actualSuppressedStates),
  };
}

/**
 * Calculate the next poll interval using exponential backoff.
 * 
 * Uses a Fibonacci-like sequence: 3, 5, 8, 13, 21, 34, 55, 60 (capped)
 * 
 * @param attempt - Current attempt number (1-based)
 * @returns Seconds to wait before next poll
 */
export function calculateBackoffSeconds(attempt: number): number {
  // Clamp to valid range
  const idx = Math.max(0, Math.min(attempt - 1, BACKOFF_SEQUENCE.length - 1));
  return BACKOFF_SEQUENCE[idx];
}

/**
 * Check if we've exceeded the maximum poll attempts.
 * 
 * @param attempts - Current number of attempts
 * @returns true if we should give up
 */
export function hasExceededMaxAttempts(attempts: number): boolean {
  return attempts >= MAX_POLL_ATTEMPTS;
}

/**
 * Get a human-readable compliance disclaimer.
 */
export function getComplianceDisclaimer(): string {
  return 'State suppression is a technical guardrail only. Users remain responsible for compliance with all applicable telemarketing laws and regulations including TCPA, state DNC lists, and time-of-day restrictions.';
}
