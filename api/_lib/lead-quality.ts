/**
 * Lead Quality Scoring Engine
 *
 * Deterministic scoring based on contact completeness and accuracy.
 * No LLM or ML - just rules that map data quality to conversion likelihood.
 *
 * Scoring factors:
 * - Match score (AudienceLab SKIPTRACE_MATCH_BY tier)
 * - Phone presence and type (wireless preferred)
 * - Address completeness
 * - Email validity (bonus)
 * - Suppression flags (penalty)
 */

import type { Lead, QualityTier } from './types.js';

/**
 * Quality score breakdown for debugging/transparency.
 */
export interface QualityScoreBreakdown {
  base: number;
  matchScoreBonus: number;
  phoneBonus: number;
  addressBonus: number;
  emailBonus: number;
  suppressionPenalty: number;
  total: number;
}

/**
 * Calculate quality score (0-100) for a lead using deterministic rules.
 *
 * Scoring algorithm:
 * - Base: 50 points
 * - Match score bonus: +20 if >=7, +10 if >=5, +0 if 3-4
 * - Phone bonus: +20 if wireless, +10 if any phone, -40 if no phone
 * - Address bonus: +10 if full address, +5 if city/state only
 * - Email bonus: +10 if email validated (even for call leads)
 * - Suppression penalty: -25 if any suppression flags
 *
 * @param lead - The lead to score
 * @param suppressionFlags - Whether lead has any suppression flags
 * @returns Quality score 0-100
 */
export function calculateQualityScore(
  lead: Lead,
  suppressionFlags: boolean = false
): number {
  const breakdown = calculateQualityScoreBreakdown(lead, suppressionFlags);
  return breakdown.total;
}

/**
 * Calculate quality score with detailed breakdown.
 */
export function calculateQualityScoreBreakdown(
  lead: Lead,
  suppressionFlags: boolean = false
): QualityScoreBreakdown {
  let base = 50;
  let matchScoreBonus = 0;
  let phoneBonus = 0;
  let addressBonus = 0;
  let emailBonus = 0;
  let suppressionPenalty = 0;

  // Match score bonus (0-3 scale, but we support higher for future)
  const matchScore = lead.match_score ?? 0;
  if (matchScore >= 7) {
    matchScoreBonus = 20;
  } else if (matchScore >= 5) {
    matchScoreBonus = 15;
  } else if (matchScore >= 3) {
    matchScoreBonus = 10;
  } else if (matchScore >= 1) {
    matchScoreBonus = 5;
  }

  // Phone bonus (wireless is most valuable for calling)
  if (lead.wireless_phones && lead.wireless_phones.trim()) {
    phoneBonus = 20;
  } else if (lead.best_phone && lead.best_phone.trim()) {
    phoneBonus = 10;
  } else if (!lead.phone || !lead.phone.trim()) {
    phoneBonus = -40; // Major penalty for no phone
  }

  // Address bonus
  const hasStreetAddress = lead.address && lead.address.trim().length > 5;
  const hasZip = lead.zip && /^\d{5}/.test(lead.zip);
  const hasCityState = lead.city && lead.state;

  if (hasStreetAddress && hasZip) {
    addressBonus = 10;
  } else if (hasCityState) {
    addressBonus = 5;
  }

  // Email bonus (validated email is valuable even for call campaigns)
  const emailStatus = lead.email_validation_status?.toLowerCase() || '';
  if (emailStatus.includes('valid')) {
    emailBonus = 10;
  } else if (lead.email && lead.email.includes('@')) {
    emailBonus = 5;
  }

  // Suppression penalty
  if (suppressionFlags) {
    suppressionPenalty = -25;
  }

  // Calculate total (clamp to 0-100)
  const total = Math.max(
    0,
    Math.min(
      100,
      base + matchScoreBonus + phoneBonus + addressBonus + emailBonus + suppressionPenalty
    )
  );

  return {
    base,
    matchScoreBonus,
    phoneBonus,
    addressBonus,
    emailBonus,
    suppressionPenalty,
    total,
  };
}

/**
 * Sort leads by quality score (descending).
 * Leads with higher scores appear first in the export.
 *
 * @param leads - Array of leads to sort
 * @returns Sorted array (mutates in place for efficiency)
 */
export function sortLeadsByQuality(leads: Lead[]): Lead[] {
  return leads.sort((a, b) => b.quality_score - a.quality_score);
}

/**
 * Calculate aggregate quality statistics for a set of leads.
 */
export interface QualityStats {
  /** Average quality score across all leads */
  avgQualityScore: number;
  /** Maximum quality score */
  maxQualityScore: number;
  /** Minimum quality score */
  minQualityScore: number;
  /** Top decile (90th percentile) quality score */
  topDecileScore: number;
  /** Count of leads with score >= 70 (high quality) */
  highQualityCount: number;
  /** Count of leads with score >= 50 and < 70 (medium quality) */
  mediumQualityCount: number;
  /** Count of leads with score < 50 (low quality) */
  lowQualityCount: number;
}

/**
 * Calculate aggregate quality statistics.
 *
 * @param leads - Array of scored leads
 * @returns Aggregate statistics
 */
export function calculateQualityStats(leads: Lead[]): QualityStats {
  if (leads.length === 0) {
    return {
      avgQualityScore: 0,
      maxQualityScore: 0,
      minQualityScore: 0,
      topDecileScore: 0,
      highQualityCount: 0,
      mediumQualityCount: 0,
      lowQualityCount: 0,
    };
  }

  const scores = leads.map((l) => l.quality_score);
  const sortedScores = [...scores].sort((a, b) => b - a);

  const sum = scores.reduce((a, b) => a + b, 0);
  const avg = sum / scores.length;
  const max = sortedScores[0];
  const min = sortedScores[sortedScores.length - 1];

  // Top decile: 90th percentile (top 10%)
  const topDecileIndex = Math.floor(sortedScores.length * 0.1);
  const topDecileScore = sortedScores[topDecileIndex] ?? max;

  // Quality buckets
  const highQualityCount = scores.filter((s) => s >= 70).length;
  const mediumQualityCount = scores.filter((s) => s >= 50 && s < 70).length;
  const lowQualityCount = scores.filter((s) => s < 50).length;

  return {
    avgQualityScore: Math.round(avg * 10) / 10, // 1 decimal place
    maxQualityScore: max,
    minQualityScore: min,
    topDecileScore,
    highQualityCount,
    mediumQualityCount,
    lowQualityCount,
  };
}

/**
 * Assign quality score to a lead (mutates the lead object).
 *
 * @param lead - Lead to score
 * @param tier - Quality tier used for generation
 * @param suppressionFlags - Whether lead has suppression flags
 * @returns The lead with quality_score and quality_tier populated
 */
export function assignQualityScore(
  lead: Lead,
  tier: QualityTier,
  suppressionFlags: boolean = false
): Lead {
  lead.quality_score = calculateQualityScore(lead, suppressionFlags);
  lead.quality_tier = tier;
  return lead;
}

/**
 * Process and score a batch of leads.
 *
 * 1. Assigns quality scores to all leads
 * 2. Sorts by quality score (descending)
 * 3. Returns leads with stats
 *
 * @param leads - Raw leads (will be mutated)
 * @param tier - Quality tier used for generation
 * @returns Scored and sorted leads with stats
 */
export function processLeadsWithQuality(
  leads: Lead[],
  tier: QualityTier
): { leads: Lead[]; stats: QualityStats } {
  // Assign scores to all leads
  for (const lead of leads) {
    assignQualityScore(lead, tier);
  }

  // Sort by quality (best first)
  sortLeadsByQuality(leads);

  // Calculate aggregate stats
  const stats = calculateQualityStats(leads);

  return { leads, stats };
}
