import { describe, it, expect } from 'vitest';
import {
  INTENT_PACKS,
  DEFAULT_PACK,
  resolveIntentPack,
  buildPackedKeywords,
  mapTierToIntentStrength,
  getRecommendedMinMatchScore,
} from '../../../api/_lib/intent-packs';
import type { QualityTier } from '../../../api/_lib/types';

describe('Intent Packs', () => {
  describe('INTENT_PACKS constants', () => {
    it('includes remodeling pack with expected keywords', () => {
      const pack = INTENT_PACKS.remodeling;

      expect(pack.id).toBe('remodeling');
      expect(pack.keywords).toContain('kitchen remodel estimate');
      expect(pack.keywords).toContain('bathroom remodel estimate');
      expect(pack.matchPatterns).toContain('remodel');
    });

    it('includes roofing pack with expected keywords', () => {
      const pack = INTENT_PACKS.roofing;

      expect(pack.id).toBe('roofing');
      expect(pack.keywords).toContain('roof repair estimate');
      expect(pack.keywords).toContain('roofing contractor near me');
      expect(pack.matchPatterns).toContain('roof');
    });

    it('includes hvac, plumbing, electrical, home_services packs', () => {
      expect(INTENT_PACKS.hvac).toBeDefined();
      expect(INTENT_PACKS.plumbing).toBeDefined();
      expect(INTENT_PACKS.electrical).toBeDefined();
      expect(INTENT_PACKS.home_services).toBeDefined();
    });

    it('DEFAULT_PACK is home_services', () => {
      expect(DEFAULT_PACK.id).toBe('home_services');
    });
  });

  describe('resolveIntentPack', () => {
    it('matches "remodeling in Miami" to remodeling pack', () => {
      const pack = resolveIntentPack('remodeling in Miami');
      expect(pack.id).toBe('remodeling');
    });

    it('matches "kitchen renovation" to remodeling pack', () => {
      const pack = resolveIntentPack('kitchen renovation');
      expect(pack.id).toBe('remodeling');
    });

    it('matches "bathroom remodel near me" to remodeling pack', () => {
      const pack = resolveIntentPack('bathroom remodel near me');
      expect(pack.id).toBe('remodeling');
    });

    it('matches "general contractor estimates" to remodeling pack', () => {
      const pack = resolveIntentPack('general contractor estimates');
      expect(pack.id).toBe('remodeling');
    });

    it('matches "roof repair" to roofing pack', () => {
      const pack = resolveIntentPack('roof repair');
      expect(pack.id).toBe('roofing');
    });

    it('matches "shingle replacement" to roofing pack', () => {
      const pack = resolveIntentPack('shingle replacement');
      expect(pack.id).toBe('roofing');
    });

    it('matches "gutter installation" to roofing pack', () => {
      const pack = resolveIntentPack('gutter installation');
      expect(pack.id).toBe('roofing');
    });

    it('matches "ac repair" to hvac pack', () => {
      const pack = resolveIntentPack('ac repair');
      expect(pack.id).toBe('hvac');
    });

    it('matches "air conditioning installation" to hvac pack', () => {
      const pack = resolveIntentPack('air conditioning installation');
      expect(pack.id).toBe('hvac');
    });

    it('matches "furnace replacement" to hvac pack', () => {
      const pack = resolveIntentPack('furnace replacement');
      expect(pack.id).toBe('hvac');
    });

    it('matches "plumber needed" to plumbing pack', () => {
      const pack = resolveIntentPack('plumber needed');
      expect(pack.id).toBe('plumbing');
    });

    it('matches "water heater installation" to plumbing pack', () => {
      const pack = resolveIntentPack('water heater installation');
      expect(pack.id).toBe('plumbing');
    });

    it('matches "drain cleaning" to plumbing pack', () => {
      const pack = resolveIntentPack('drain cleaning');
      expect(pack.id).toBe('plumbing');
    });

    it('matches "electrician near me" to electrical pack', () => {
      const pack = resolveIntentPack('electrician near me');
      expect(pack.id).toBe('electrical');
    });

    it('matches "wiring repair" to electrical pack', () => {
      const pack = resolveIntentPack('wiring repair');
      expect(pack.id).toBe('electrical');
    });

    it('falls back to home_services for generic request', () => {
      const pack = resolveIntentPack('home repair services');
      expect(pack.id).toBe('home_services');
    });

    it('falls back to home_services for unrecognized request', () => {
      const pack = resolveIntentPack('auto mechanic');
      expect(pack.id).toBe('home_services');
    });

    it('is case-insensitive', () => {
      expect(resolveIntentPack('REMODELING').id).toBe('remodeling');
      expect(resolveIntentPack('RoOfInG').id).toBe('roofing');
      expect(resolveIntentPack('HVAC').id).toBe('hvac');
    });

    it('handles whitespace', () => {
      expect(resolveIntentPack('  roofing  ').id).toBe('roofing');
    });
  });

  describe('buildPackedKeywords', () => {
    it('includes original request as first keyword', () => {
      const pack = INTENT_PACKS.roofing;
      const keywords = buildPackedKeywords('roof repair Miami', pack);

      const lines = keywords.split('\n');
      expect(lines[0]).toBe('roof repair Miami');
    });

    it('includes pack keywords', () => {
      const pack = INTENT_PACKS.roofing;
      const keywords = buildPackedKeywords('roof repair', pack);

      expect(keywords).toContain('roof repair estimate');
      expect(keywords).toContain('roofing contractor near me');
    });

    it('deduplicates if original request matches a pack keyword', () => {
      const pack = INTENT_PACKS.roofing;
      const keywords = buildPackedKeywords('roof repair estimate', pack);

      const lines = keywords.split('\n');
      const occurrences = lines.filter((l) => l === 'roof repair estimate').length;
      expect(occurrences).toBe(1);
    });

    it('uses newline separator for AudienceLab API', () => {
      const pack = INTENT_PACKS.roofing;
      const keywords = buildPackedKeywords('roof repair', pack);

      expect(keywords).toContain('\n');
      expect(keywords).not.toContain(',');
    });

    it('trims whitespace from original request', () => {
      const pack = INTENT_PACKS.roofing;
      const keywords = buildPackedKeywords('  roof repair  ', pack);

      const lines = keywords.split('\n');
      expect(lines[0]).toBe('roof repair');
    });
  });

  describe('mapTierToIntentStrength', () => {
    it('maps hot tier to high-only intent', () => {
      const strength = mapTierToIntentStrength('hot');
      expect(strength).toEqual(['high']);
    });

    it('maps balanced tier to high + medium intent', () => {
      const strength = mapTierToIntentStrength('balanced');
      expect(strength).toEqual(['high', 'medium']);
    });

    it('maps scale tier to medium + low intent', () => {
      const strength = mapTierToIntentStrength('scale');
      expect(strength).toEqual(['medium', 'low']);
    });

    it('defaults to balanced for unknown tier', () => {
      const strength = mapTierToIntentStrength('unknown' as QualityTier);
      expect(strength).toEqual(['high', 'medium']);
    });
  });

  describe('getRecommendedMinMatchScore', () => {
    it('returns 5 for hot tier (strict)', () => {
      expect(getRecommendedMinMatchScore('hot')).toBe(5);
    });

    it('returns 3 for balanced tier', () => {
      expect(getRecommendedMinMatchScore('balanced')).toBe(3);
    });

    it('returns 3 for scale tier', () => {
      expect(getRecommendedMinMatchScore('scale')).toBe(3);
    });

    it('defaults to 3 for unknown tier', () => {
      expect(getRecommendedMinMatchScore('unknown' as QualityTier)).toBe(3);
    });
  });
});
