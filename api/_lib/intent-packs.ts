/**
 * Intent Packs - Vertical-specific high-intent keyword targeting.
 *
 * Each pack contains curated keywords optimized for conversion:
 * - High-intent terms (quotes, estimates, near me, cost)
 * - Service-specific variants
 * - Sub-intents that indicate buying readiness
 *
 * The resolver matches user input to the best pack, enhancing
 * keyword targeting without requiring users to know optimal terms.
 */

import type { QualityTier } from './types.js';

/**
 * Intent pack structure with keywords and metadata.
 */
export interface IntentPack {
  /** Pack identifier */
  id: string;
  /** Display name */
  name: string;
  /** High-intent keyword variants */
  keywords: string[];
  /** Match patterns (lowercase) for resolver */
  matchPatterns: string[];
}

/**
 * Curated intent packs for common home services verticals.
 */
export const INTENT_PACKS: Record<string, IntentPack> = {
  remodeling: {
    id: 'remodeling',
    name: 'Remodeling & Renovation',
    keywords: [
      'kitchen remodel estimate',
      'bathroom remodel estimate',
      'home renovation contractor',
      'remodeling contractor near me',
      'general contractor estimate',
      'renovation quote',
      'kitchen remodel cost',
      'bathroom renovation contractor',
      'home improvement contractor',
      'kitchen renovation near me',
      'bathroom remodel near me',
      'home remodel cost',
      'renovation cost estimate',
      'remodel financing',
    ],
    matchPatterns: [
      'remodel',
      'renov',
      'kitchen',
      'bathroom',
      'home improvement',
      'general contractor',
    ],
  },

  roofing: {
    id: 'roofing',
    name: 'Roofing Services',
    keywords: [
      'roof repair estimate',
      'roof replacement cost',
      'roofing contractor near me',
      'roof inspection',
      'roof leak repair',
      'new roof estimate',
      'roofing quote',
      'shingle repair',
      'metal roof installation',
      'roof damage repair',
      'emergency roof repair',
      'roof replacement near me',
    ],
    matchPatterns: [
      'roof',
      'shingle',
      'gutter',
    ],
  },

  hvac: {
    id: 'hvac',
    name: 'HVAC Services',
    keywords: [
      'ac repair near me',
      'hvac installation cost',
      'furnace repair estimate',
      'air conditioning replacement',
      'heating repair near me',
      'hvac contractor',
      'ac unit cost',
      'central air installation',
      'heat pump installation',
      'hvac maintenance',
    ],
    matchPatterns: [
      'hvac',
      'air condition',
      'ac repair',
      'ac install',
      'furnace',
      'heating',
      'cooling',
      'heat pump',
    ],
  },

  plumbing: {
    id: 'plumbing',
    name: 'Plumbing Services',
    keywords: [
      'plumber near me',
      'plumbing repair estimate',
      'water heater installation',
      'drain cleaning',
      'pipe repair',
      'emergency plumber',
      'sewer line repair',
      'water heater replacement cost',
      'bathroom plumbing',
      'kitchen plumbing repair',
    ],
    matchPatterns: [
      'plumb',
      'water heater',
      'drain',
      'pipe',
      'sewer',
      'leak',
      'faucet',
    ],
  },

  electrical: {
    id: 'electrical',
    name: 'Electrical Services',
    keywords: [
      'electrician near me',
      'electrical repair',
      'panel upgrade cost',
      'wiring repair',
      'outlet installation',
      'lighting installation',
      'electrical inspection',
      'generator installation',
      'ev charger installation',
    ],
    matchPatterns: [
      'electric',
      'wiring',
      'outlet',
      'panel',
      'circuit',
      'lighting install',
    ],
  },

  home_services: {
    id: 'home_services',
    name: 'General Home Services',
    keywords: [
      'home repair estimate',
      'handyman near me',
      'home maintenance',
      'contractor estimate',
      'home service quote',
      'repair estimate',
      'home contractor',
    ],
    matchPatterns: [
      'home repair',
      'handyman',
      'contractor',
      'home service',
      'maintenance',
    ],
  },
};

/**
 * Default/fallback pack when no specific vertical matches.
 */
export const DEFAULT_PACK: IntentPack = INTENT_PACKS.home_services;

/**
 * Resolve the best intent pack for a given lead request.
 *
 * Matching logic (in order):
 * 1. Check each pack's matchPatterns against the lowercase request
 * 2. First match wins (packs ordered by specificity)
 * 3. Falls back to generic home_services pack
 *
 * @param leadRequest - User's lead request string
 * @returns The best matching IntentPack
 */
export function resolveIntentPack(leadRequest: string): IntentPack {
  const normalized = leadRequest.toLowerCase().trim();

  // Check packs in order of specificity (most specific first)
  const packOrder = ['remodeling', 'roofing', 'hvac', 'plumbing', 'electrical', 'home_services'];

  for (const packId of packOrder) {
    const pack = INTENT_PACKS[packId];
    if (!pack) continue;

    for (const pattern of pack.matchPatterns) {
      if (normalized.includes(pattern)) {
        return pack;
      }
    }
  }

  return DEFAULT_PACK;
}

/**
 * Build combined keywords from intent pack and original request.
 *
 * Deduplicates and formats for AudienceLab API (newline-separated).
 *
 * @param leadRequest - Original user request
 * @param pack - Resolved intent pack
 * @returns Combined keyword string
 */
export function buildPackedKeywords(leadRequest: string, pack: IntentPack): string {
  const keywords = new Set<string>();

  // Add original request first (user's exact intent)
  keywords.add(leadRequest.trim());

  // Add pack keywords
  for (const kw of pack.keywords) {
    keywords.add(kw);
  }

  // Join with newlines (AudienceLab accepts newline-separated keywords)
  return Array.from(keywords).join('\n');
}

/**
 * Map quality tier to intent_strength filter values.
 *
 * - hot: Only high-intent signals (max conversion)
 * - balanced: High + medium intent (default)
 * - scale: Medium + low intent (more volume)
 *
 * @param tier - Quality tier selection
 * @returns Array of intent_strength values for AudienceLab
 */
export function mapTierToIntentStrength(tier: QualityTier): string[] {
  switch (tier) {
    case 'hot':
      return ['high'];
    case 'balanced':
      return ['high', 'medium'];
    case 'scale':
      return ['medium', 'low'];
    default:
      return ['high', 'medium'];
  }
}

/**
 * Get recommended minMatchScore for a quality tier.
 *
 * - hot: 5 (strict)
 * - balanced: 3 (default)
 * - scale: 3 (volume over strict quality)
 *
 * @param tier - Quality tier selection
 * @returns Recommended minimum match score
 */
export function getRecommendedMinMatchScore(tier: QualityTier): number {
  switch (tier) {
    case 'hot':
      return 5;
    case 'balanced':
      return 3;
    case 'scale':
      return 3;
    default:
      return 3;
  }
}
