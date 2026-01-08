import { describe, it, expect } from 'vitest';
import {
  calculateQualityScore,
  calculateQualityScoreBreakdown,
  sortLeadsByQuality,
  calculateQualityStats,
  assignQualityScore,
  processLeadsWithQuality,
} from '../../../api/_lib/lead-quality';
import type { Lead } from '../../../api/_lib/types';

/**
 * Factory for creating test leads with defaults.
 */
function createLead(overrides: Partial<Lead> = {}): Lead {
  return {
    first_name: 'John',
    last_name: 'Doe',
    address: '123 Main St',
    city: 'Miami',
    state: 'FL',
    zip: '33101',
    phone: '305-555-1234',
    email: 'john@example.com',
    lead_type: 'residential',
    tags: '',
    source: 'AudienceLab',
    best_phone: '305-555-1234',
    phones_all: '305-555-1234',
    wireless_phones: '',
    landline_phones: '305-555-1234',
    match_score: 3,
    quality_score: 0,
    quality_tier: 'balanced',
    dnc_status: 'clean',
    email_validation_status: '',
    ...overrides,
  };
}

describe('Lead Quality Scoring', () => {
  describe('calculateQualityScore', () => {
    it('returns base score minus penalty for minimal lead', () => {
      const lead = createLead({
        address: '',
        phone: '',
        best_phone: '',
        wireless_phones: '',
        landline_phones: '',
        email: '',
        match_score: 0,
        city: 'Miami', // city+state gives +5 address bonus
        state: 'FL',
      });

      // Base 50 - 40 (no phone) + 5 (city/state) = 15
      expect(calculateQualityScore(lead)).toBe(15);
    });

    it('adds +20 bonus for match_score >= 7', () => {
      const lead = createLead({ match_score: 7 });
      const baseScore = calculateQualityScore(createLead({ match_score: 0 }));
      const highMatchScore = calculateQualityScore(lead);

      expect(highMatchScore - baseScore).toBe(20);
    });

    it('adds +15 bonus for match_score >= 5 and < 7', () => {
      const lead = createLead({ match_score: 5 });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.matchScoreBonus).toBe(15);
    });

    it('adds +10 bonus for match_score >= 3 and < 5', () => {
      const lead = createLead({ match_score: 3 });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.matchScoreBonus).toBe(10);
    });

    it('adds +5 bonus for match_score >= 1 and < 3', () => {
      const lead = createLead({ match_score: 1 });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.matchScoreBonus).toBe(5);
    });

    it('adds +20 bonus for wireless phone', () => {
      const lead = createLead({ wireless_phones: '305-555-1234' });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.phoneBonus).toBe(20);
    });

    it('adds +10 bonus for any phone (non-wireless)', () => {
      const lead = createLead({
        best_phone: '305-555-1234',
        wireless_phones: '',
      });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.phoneBonus).toBe(10);
    });

    it('applies -40 penalty for missing phone', () => {
      const lead = createLead({
        phone: '',
        best_phone: '',
        wireless_phones: '',
        landline_phones: '',
      });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.phoneBonus).toBe(-40);
    });

    it('adds +10 bonus for full address with zip', () => {
      const lead = createLead({
        address: '123 Main Street',
        zip: '33101',
      });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.addressBonus).toBe(10);
    });

    it('adds +5 bonus for city/state only (no address)', () => {
      const lead = createLead({
        address: '',
        city: 'Miami',
        state: 'FL',
        zip: '',
      });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.addressBonus).toBe(5);
    });

    it('adds +10 bonus for validated email', () => {
      const lead = createLead({
        email: 'john@example.com',
        email_validation_status: 'valid',
      });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.emailBonus).toBe(10);
    });

    it('adds +5 bonus for unvalidated email with @', () => {
      const lead = createLead({
        email: 'john@example.com',
        email_validation_status: '',
      });
      const breakdown = calculateQualityScoreBreakdown(lead);

      expect(breakdown.emailBonus).toBe(5);
    });

    it('applies -25 penalty for suppression flags', () => {
      const lead = createLead();
      const breakdown = calculateQualityScoreBreakdown(lead, true);

      expect(breakdown.suppressionPenalty).toBe(-25);
    });

    it('clamps score to minimum of 0', () => {
      const lead = createLead({
        address: '',
        phone: '',
        best_phone: '',
        wireless_phones: '',
        match_score: 0,
        email: '',
      });

      // Base 50 - 40 (no phone) = 10, even with suppression = -15
      const score = calculateQualityScore(lead, true);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('clamps score to maximum of 100', () => {
      const lead = createLead({
        match_score: 10,
        wireless_phones: '305-555-1234',
        address: '123 Main St',
        zip: '33101',
        email: 'john@example.com',
        email_validation_status: 'valid',
      });

      // 50 + 20 + 20 + 10 + 10 = 110 -> clamped to 100
      const score = calculateQualityScore(lead);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('calculates realistic high-quality lead score', () => {
      const lead = createLead({
        match_score: 3, // +10
        wireless_phones: '305-555-1234', // +20
        address: '123 Main St', // +10
        zip: '33101',
        email: 'john@example.com', // +5
        email_validation_status: '',
      });

      // 50 + 10 + 20 + 10 + 5 = 95
      expect(calculateQualityScore(lead)).toBe(95);
    });

    it('calculates realistic low-quality lead score', () => {
      const lead = createLead({
        match_score: 0, // +0
        wireless_phones: '', // not wireless
        best_phone: '305-555-1234', // +10
        address: '', // no address bonus
        city: '',
        state: '',
        zip: '',
        email: '', // no email bonus
      });

      // 50 + 0 + 10 + 0 + 0 = 60
      expect(calculateQualityScore(lead)).toBe(60);
    });
  });

  describe('sortLeadsByQuality', () => {
    it('sorts leads by quality_score descending', () => {
      const leads = [
        createLead({ quality_score: 50 }),
        createLead({ quality_score: 90 }),
        createLead({ quality_score: 70 }),
      ];

      sortLeadsByQuality(leads);

      expect(leads[0].quality_score).toBe(90);
      expect(leads[1].quality_score).toBe(70);
      expect(leads[2].quality_score).toBe(50);
    });

    it('maintains order for equal scores', () => {
      const leads = [
        createLead({ first_name: 'A', quality_score: 70 }),
        createLead({ first_name: 'B', quality_score: 70 }),
      ];

      sortLeadsByQuality(leads);

      // Stable sort - original order maintained
      expect(leads[0].first_name).toBe('A');
      expect(leads[1].first_name).toBe('B');
    });

    it('handles empty array', () => {
      const leads: Lead[] = [];
      expect(() => sortLeadsByQuality(leads)).not.toThrow();
      expect(leads).toEqual([]);
    });

    it('handles single lead', () => {
      const leads = [createLead({ quality_score: 75 })];
      sortLeadsByQuality(leads);
      expect(leads[0].quality_score).toBe(75);
    });
  });

  describe('calculateQualityStats', () => {
    it('returns zeros for empty array', () => {
      const stats = calculateQualityStats([]);

      expect(stats.avgQualityScore).toBe(0);
      expect(stats.maxQualityScore).toBe(0);
      expect(stats.minQualityScore).toBe(0);
      expect(stats.highQualityCount).toBe(0);
      expect(stats.mediumQualityCount).toBe(0);
      expect(stats.lowQualityCount).toBe(0);
    });

    it('calculates average score correctly', () => {
      const leads = [
        createLead({ quality_score: 60 }),
        createLead({ quality_score: 80 }),
        createLead({ quality_score: 70 }),
      ];

      const stats = calculateQualityStats(leads);

      expect(stats.avgQualityScore).toBe(70);
    });

    it('calculates min and max correctly', () => {
      const leads = [
        createLead({ quality_score: 45 }),
        createLead({ quality_score: 90 }),
        createLead({ quality_score: 65 }),
      ];

      const stats = calculateQualityStats(leads);

      expect(stats.maxQualityScore).toBe(90);
      expect(stats.minQualityScore).toBe(45);
    });

    it('counts high quality leads (>= 70)', () => {
      const leads = [
        createLead({ quality_score: 70 }),
        createLead({ quality_score: 85 }),
        createLead({ quality_score: 65 }),
      ];

      const stats = calculateQualityStats(leads);

      expect(stats.highQualityCount).toBe(2);
    });

    it('counts medium quality leads (>= 50 and < 70)', () => {
      const leads = [
        createLead({ quality_score: 50 }),
        createLead({ quality_score: 69 }),
        createLead({ quality_score: 70 }),
        createLead({ quality_score: 49 }),
      ];

      const stats = calculateQualityStats(leads);

      expect(stats.mediumQualityCount).toBe(2);
    });

    it('counts low quality leads (< 50)', () => {
      const leads = [
        createLead({ quality_score: 49 }),
        createLead({ quality_score: 30 }),
        createLead({ quality_score: 50 }),
      ];

      const stats = calculateQualityStats(leads);

      expect(stats.lowQualityCount).toBe(2);
    });

    it('calculates top decile score', () => {
      const leads = Array.from({ length: 10 }, (_, i) =>
        createLead({ quality_score: (i + 1) * 10 }) // 10, 20, 30, ..., 100
      );

      const stats = calculateQualityStats(leads);

      // Top decile index = floor(10 * 0.1) = 1, sorted descending: [100, 90, ...]
      // Index 1 gives 90
      expect(stats.topDecileScore).toBe(90);
    });
  });

  describe('assignQualityScore', () => {
    it('mutates lead with quality_score', () => {
      const lead = createLead();
      lead.quality_score = 0;

      assignQualityScore(lead, 'hot');

      expect(lead.quality_score).toBeGreaterThan(0);
    });

    it('sets quality_tier on lead', () => {
      const lead = createLead();

      assignQualityScore(lead, 'hot');

      expect(lead.quality_tier).toBe('hot');
    });

    it('accounts for suppression flags', () => {
      const lead = createLead();

      const scoreWithout = assignQualityScore({ ...lead }, 'balanced', false).quality_score;
      const scoreWith = assignQualityScore({ ...lead }, 'balanced', true).quality_score;

      expect(scoreWith).toBe(scoreWithout - 25);
    });
  });

  describe('processLeadsWithQuality', () => {
    it('assigns scores and sorts leads', () => {
      const leads = [
        createLead({
          match_score: 1,
          wireless_phones: '',
          best_phone: '123',
          address: '',
          email: '',
        }), // Low score
        createLead({
          match_score: 7,
          wireless_phones: '555',
          address: '123 St',
          zip: '12345',
          email: 'a@b.com',
          email_validation_status: 'valid',
        }), // High score
      ];

      const result = processLeadsWithQuality(leads, 'balanced');

      // High score lead should be first after sorting
      expect(result.leads[0].quality_score).toBeGreaterThan(result.leads[1].quality_score);
    });

    it('returns quality stats', () => {
      const leads = [
        createLead({ match_score: 3, wireless_phones: '555' }),
        createLead({ match_score: 1, wireless_phones: '' }),
      ];

      const result = processLeadsWithQuality(leads, 'balanced');

      expect(result.stats).toBeDefined();
      expect(result.stats.avgQualityScore).toBeGreaterThan(0);
    });

    it('sets quality_tier on all leads', () => {
      const leads = [createLead(), createLead(), createLead()];

      const result = processLeadsWithQuality(leads, 'hot');

      for (const lead of result.leads) {
        expect(lead.quality_tier).toBe('hot');
      }
    });

    it('handles empty array', () => {
      const result = processLeadsWithQuality([], 'balanced');

      expect(result.leads).toEqual([]);
      expect(result.stats.avgQualityScore).toBe(0);
    });
  });
});
