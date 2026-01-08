/**
 * Quality Gate Module
 *
 * Filters leads based on tier-specific quality thresholds to ensure
 * exported leads meet minimum quality standards. Generates detailed
 * quality reports for transparency.
 */

import { Lead, QualityTier } from './types';

// Quality gate thresholds per tier
export interface QualityGateThreshold {
  minQualityScore: number;
  minMatchScore: number;
  requireWirelessPhone: boolean; // For CALL campaigns on hot tier
}

export const QUALITY_GATE_THRESHOLDS: Record<QualityTier, QualityGateThreshold> = {
  hot: {
    minQualityScore: 70,
    minMatchScore: 5,
    requireWirelessPhone: true,
  },
  balanced: {
    minQualityScore: 50,
    minMatchScore: 3,
    requireWirelessPhone: false,
  },
  scale: {
    minQualityScore: 30,
    minMatchScore: 3,
    requireWirelessPhone: false,
  },
};

export interface QualityGateResult {
  passedLeads: Lead[];
  rejectedLeads: Lead[];
  deliveredCount: number;
  rejectedByQualityCount: number;
  minQualityScoreUsed: number;
  warning?: string;
}

export interface QualityReport {
  deliveredCount: number;
  rejectedByQualityCount: number;
  minQualityScoreUsed: number;
  avgQualityScore: number;
  p90QualityScore: number;
  pctWireless: number;
  pctWithAddress: number;
  matchScoreDistribution: Record<string, number>;
  warning?: string;
}

/**
 * Apply quality gate filtering based on tier thresholds.
 * Filters leads AFTER suppression - never pads with low-quality leads.
 *
 * @param leads - Leads after compliance/suppression filtering
 * @param tier - Quality tier (hot, balanced, scale)
 * @param requestedCount - Original requested lead count
 * @param isCallCampaign - Whether wireless phone is required (hot tier)
 */
export function applyQualityGate(
  leads: Lead[],
  tier: QualityTier,
  requestedCount: number,
  isCallCampaign = false
): QualityGateResult {
  const threshold = QUALITY_GATE_THRESHOLDS[tier];

  const passed: Lead[] = [];
  const rejected: Lead[] = [];

  for (const lead of leads) {
    const qualityScore = lead.quality_score ?? 0;
    const matchScore = lead.match_score ?? 0;
    const hasWireless =
      lead.wireless_phones && lead.wireless_phones.length > 0;

    // Check quality gate criteria
    const meetsQualityScore = qualityScore >= threshold.minQualityScore;
    const meetsMatchScore = matchScore >= threshold.minMatchScore;
    const meetsWirelessRequirement =
      !threshold.requireWirelessPhone ||
      !isCallCampaign ||
      hasWireless;

    if (meetsQualityScore && meetsMatchScore && meetsWirelessRequirement) {
      passed.push(lead);
    } else {
      rejected.push(lead);
    }
  }

  // Sort passed leads by quality score descending (best first)
  passed.sort((a, b) => (b.quality_score ?? 0) - (a.quality_score ?? 0));

  // Generate warning if we couldn't deliver enough leads
  let warning: string | undefined;
  if (passed.length < requestedCount) {
    const tierLabel =
      tier === 'hot'
        ? 'Hot (≥70)'
        : tier === 'balanced'
        ? 'Balanced (≥50)'
        : 'Scale (≥30)';
    warning = `Quality Gate: Delivered ${passed.length} of ${requestedCount} requested. ${rejected.length} leads rejected (below ${tierLabel} threshold).`;
  }

  return {
    passedLeads: passed,
    rejectedLeads: rejected,
    deliveredCount: passed.length,
    rejectedByQualityCount: rejected.length,
    minQualityScoreUsed: threshold.minQualityScore,
    warning,
  };
}

/**
 * Calculate p90 (90th percentile) quality score.
 * Returns the score at which 90% of leads fall below.
 */
export function calculateP90QualityScore(leads: Lead[]): number {
  if (leads.length === 0) return 0;

  const scores = leads
    .map((l) => l.quality_score ?? 0)
    .sort((a, b) => a - b);

  const p90Index = Math.floor(scores.length * 0.9);
  return scores[Math.min(p90Index, scores.length - 1)];
}

/**
 * Calculate percentage of leads with wireless phone.
 */
export function calculatePctWireless(leads: Lead[]): number {
  if (leads.length === 0) return 0;

  const withWireless = leads.filter(
    (l) => l.wireless_phones && l.wireless_phones.length > 0
  ).length;

  return Math.round((withWireless / leads.length) * 100);
}

/**
 * Calculate percentage of leads with full address.
 */
export function calculatePctWithAddress(leads: Lead[]): number {
  if (leads.length === 0) return 0;

  const withAddress = leads.filter(
    (l) => l.address && l.city && l.state && l.zip
  ).length;

  return Math.round((withAddress / leads.length) * 100);
}

/**
 * Calculate match score distribution.
 * Returns counts for each match score level.
 */
export function calculateMatchScoreDistribution(
  leads: Lead[]
): Record<string, number> {
  const distribution: Record<string, number> = {
    score_0: 0,
    score_1: 0,
    score_2: 0,
    score_3: 0,
    score_4: 0,
    score_5_plus: 0,
  };

  for (const lead of leads) {
    const score = lead.match_score ?? 0;
    if (score === 0) distribution.score_0++;
    else if (score === 1) distribution.score_1++;
    else if (score === 2) distribution.score_2++;
    else if (score === 3) distribution.score_3++;
    else if (score === 4) distribution.score_4++;
    else distribution.score_5_plus++;
  }

  return distribution;
}

/**
 * Generate complete quality report for delivered leads.
 */
export function generateQualityReport(
  deliveredLeads: Lead[],
  rejectedCount: number,
  minQualityScoreUsed: number,
  requestedCount: number,
  tier: QualityTier
): QualityReport {
  const deliveredCount = deliveredLeads.length;

  // Calculate average quality score
  const avgQualityScore =
    deliveredCount > 0
      ? Math.round(
          deliveredLeads.reduce((sum, l) => sum + (l.quality_score ?? 0), 0) /
            deliveredCount
        )
      : 0;

  // Generate warning if applicable
  let warning: string | undefined;
  if (deliveredCount < requestedCount) {
    const tierLabel =
      tier === 'hot'
        ? 'Hot (≥70)'
        : tier === 'balanced'
        ? 'Balanced (≥50)'
        : 'Scale (≥30)';
    warning = `Quality Gate: Delivered ${deliveredCount} of ${requestedCount} requested. ${rejectedCount} leads rejected (below ${tierLabel} threshold).`;
  }

  return {
    deliveredCount,
    rejectedByQualityCount: rejectedCount,
    minQualityScoreUsed,
    avgQualityScore,
    p90QualityScore: calculateP90QualityScore(deliveredLeads),
    pctWireless: calculatePctWireless(deliveredLeads),
    pctWithAddress: calculatePctWithAddress(deliveredLeads),
    matchScoreDistribution: calculateMatchScoreDistribution(deliveredLeads),
    warning,
  };
}

/**
 * Get human-readable tier label for UI display.
 */
export function getTierLabel(tier: QualityTier): string {
  const threshold = QUALITY_GATE_THRESHOLDS[tier];
  return `${tier.charAt(0).toUpperCase() + tier.slice(1)} (≥${threshold.minQualityScore})`;
}
