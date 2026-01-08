import { describe, it, expect } from 'vitest';
import {
  applyQualityGate,
  calculateP90QualityScore,
  calculatePctWireless,
  calculatePctWithAddress,
  calculateMatchScoreDistribution,
  generateQualityReport,
  getTierLabel,
  QUALITY_GATE_THRESHOLDS,
} from '../../../api/_lib/quality-gate';
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
    phone: '************',
    email: 'john@example.com',
    lead_type: 'residential',
    tags: '',
    source: 'AudienceLab',
    best_phone: '************',
    phones_all: '************',
    wireless_phones: '5551234567',
    landline_phones: '',
    match_score: 5,
    quality_score: 75,
    quality_tier: 'balanced',
    dnc_status: 'clean',
    email_validation_status: 'valid',
    ...overrides,
  };
}

describe('Quality Gate Module', () => {
  describe('QUALITY_GATE_THRESHOLDS', () => {
    it('defines correct thresholds for hot tier', () => {
      expect(QUALITY_GATE_THRESHOLDS.hot).toEqual({
        minQualityScore: 70,
        minMatchScore: 5,
        requireWirelessPhone: true,
      });
    });

    it('defines correct thresholds for balanced tier', () => {
      expect(QUALITY_GATE_THRESHOLDS.balanced).toEqual({
        minQualityScore: 50,
        minMatchScore: 3,
        requireWirelessPhone: false,
      });
    });

    it('defines correct thresholds for scale tier', () => {
      expect(QUALITY_GATE_THRESHOLDS.scale).toEqual({
        minQualityScore: 30,
        minMatchScore: 3,
        requireWirelessPhone: false,
      });
    });
  });

  describe('applyQualityGate', () => {
    describe('hot tier filtering', () => {
      it('passes leads meeting all hot tier criteria', () => {
        const leads = [
          createLead({ quality_score: 75, match_score: 5, wireless_phones: '555' }),
          createLead({ quality_score: 80, match_score: 6, wireless_phones: '666' }),
        ];

        const result = applyQualityGate(leads, 'hot', 10, true);

        expect(result.passedLeads).toHaveLength(2);
        expect(result.rejectedLeads).toHaveLength(0);
      });

      it('rejects leads with low quality score for hot tier', () => {
        const leads = [
          createLead({ quality_score: 69, match_score: 5, wireless_phones: '555' }),
          createLead({ quality_score: 75, match_score: 5, wireless_phones: '666' }),
        ];

        const result = applyQualityGate(leads, 'hot', 10, true);

        expect(result.passedLeads).toHaveLength(1);
        expect(result.rejectedLeads).toHaveLength(1);
        expect(result.rejectedLeads[0].quality_score).toBe(69);
      });

      it('rejects leads with low match score for hot tier', () => {
        const leads = [
          createLead({ quality_score: 80, match_score: 4, wireless_phones: '555' }),
          createLead({ quality_score: 75, match_score: 5, wireless_phones: '666' }),
        ];

        const result = applyQualityGate(leads, 'hot', 10, true);

        expect(result.passedLeads).toHaveLength(1);
        expect(result.rejectedLeads).toHaveLength(1);
        expect(result.rejectedLeads[0].match_score).toBe(4);
      });

      it('rejects leads without wireless phone for hot tier + call campaign', () => {
        const leads = [
          createLead({ quality_score: 80, match_score: 5, wireless_phones: '' }),
          createLead({ quality_score: 75, match_score: 5, wireless_phones: '666' }),
        ];

        const result = applyQualityGate(leads, 'hot', 10, true);

        expect(result.passedLeads).toHaveLength(1);
        expect(result.rejectedLeads).toHaveLength(1);
        expect(result.rejectedLeads[0].wireless_phones).toBe('');
      });

      it('passes leads without wireless phone for hot tier + non-call campaign', () => {
        const leads = [
          createLead({ quality_score: 80, match_score: 5, wireless_phones: '' }),
          createLead({ quality_score: 75, match_score: 5, wireless_phones: '666' }),
        ];

        const result = applyQualityGate(leads, 'hot', 10, false);

        expect(result.passedLeads).toHaveLength(2);
        expect(result.rejectedLeads).toHaveLength(0);
      });
    });

    describe('balanced tier filtering', () => {
      it('passes leads meeting balanced tier criteria', () => {
        const leads = [
          createLead({ quality_score: 50, match_score: 3, wireless_phones: '' }),
          createLead({ quality_score: 65, match_score: 4, wireless_phones: '' }),
        ];

        const result = applyQualityGate(leads, 'balanced', 10);

        expect(result.passedLeads).toHaveLength(2);
        expect(result.rejectedLeads).toHaveLength(0);
      });

      it('rejects leads below balanced tier threshold', () => {
        const leads = [
          createLead({ quality_score: 49, match_score: 3, wireless_phones: '' }),
          createLead({ quality_score: 50, match_score: 2, wireless_phones: '' }),
          createLead({ quality_score: 60, match_score: 4, wireless_phones: '' }),
        ];

        const result = applyQualityGate(leads, 'balanced', 10);

        expect(result.passedLeads).toHaveLength(1);
        expect(result.rejectedLeads).toHaveLength(2);
      });

      it('does not require wireless phone for balanced tier', () => {
        const leads = [
          createLead({ quality_score: 60, match_score: 4, wireless_phones: '' }),
        ];

        const result = applyQualityGate(leads, 'balanced', 10, true);

        expect(result.passedLeads).toHaveLength(1);
      });
    });

    describe('scale tier filtering', () => {
      it('passes leads meeting scale tier criteria', () => {
        const leads = [
          createLead({ quality_score: 30, match_score: 3, wireless_phones: '' }),
          createLead({ quality_score: 45, match_score: 5, wireless_phones: '' }),
        ];

        const result = applyQualityGate(leads, 'scale', 10);

        expect(result.passedLeads).toHaveLength(2);
      });

      it('rejects leads below scale tier threshold', () => {
        const leads = [
          createLead({ quality_score: 29, match_score: 3, wireless_phones: '' }),
          createLead({ quality_score: 40, match_score: 2, wireless_phones: '' }),
        ];

        const result = applyQualityGate(leads, 'scale', 10);

        expect(result.passedLeads).toHaveLength(0);
        expect(result.rejectedLeads).toHaveLength(2);
      });
    });

    describe('sorting and warnings', () => {
      it('sorts passed leads by quality score descending', () => {
        const leads = [
          createLead({ quality_score: 75, match_score: 5 }),
          createLead({ quality_score: 90, match_score: 6 }),
          createLead({ quality_score: 70, match_score: 5 }),
        ];

        const result = applyQualityGate(leads, 'balanced', 10);

        expect(result.passedLeads[0].quality_score).toBe(90);
        expect(result.passedLeads[1].quality_score).toBe(75);
        expect(result.passedLeads[2].quality_score).toBe(70);
      });

      it('generates warning when delivered < requested', () => {
        const leads = [
          createLead({ quality_score: 75, match_score: 5 }),
        ];

        const result = applyQualityGate(leads, 'hot', 10, true);

        expect(result.warning).toBeDefined();
        expect(result.warning).toContain('Delivered 1 of 10 requested');
      });

      it('does not generate warning when delivered >= requested', () => {
        const leads = [
          createLead({ quality_score: 75, match_score: 5 }),
          createLead({ quality_score: 80, match_score: 6 }),
        ];

        const result = applyQualityGate(leads, 'balanced', 2);

        expect(result.warning).toBeUndefined();
      });

      it('never pads with low-quality leads', () => {
        const leads = [
          createLead({ quality_score: 75, match_score: 5 }),
          createLead({ quality_score: 40, match_score: 2 }), // Below balanced threshold
        ];

        const result = applyQualityGate(leads, 'balanced', 10);

        expect(result.passedLeads).toHaveLength(1);
        expect(result.deliveredCount).toBe(1);
        // Even though we requested 10, we only deliver 1 - no padding
        expect(result.warning).toContain('Delivered 1 of 10 requested');
      });
    });

    describe('result fields', () => {
      it('returns correct counts', () => {
        const leads = [
          createLead({ quality_score: 75, match_score: 5 }),
          createLead({ quality_score: 80, match_score: 6 }),
          createLead({ quality_score: 45, match_score: 2 }),
        ];

        const result = applyQualityGate(leads, 'balanced', 10);

        expect(result.deliveredCount).toBe(2);
        expect(result.rejectedByQualityCount).toBe(1);
        expect(result.minQualityScoreUsed).toBe(50);
      });
    });
  });

  describe('calculateP90QualityScore', () => {
    it('returns 0 for empty array', () => {
      expect(calculateP90QualityScore([])).toBe(0);
    });

    it('returns correct p90 for 10 leads', () => {
      const leads = Array.from({ length: 10 }, (_, i) =>
        createLead({ quality_score: (i + 1) * 10 }) // 10, 20, 30, ..., 100
      );

      const p90 = calculateP90QualityScore(leads);

      // 90th percentile of [10,20,30,40,50,60,70,80,90,100] = index 9 (0.9 * 10 = 9) = 100
      expect(p90).toBe(100);
    });

    it('handles single lead', () => {
      const leads = [createLead({ quality_score: 75 })];
      expect(calculateP90QualityScore(leads)).toBe(75);
    });
  });

  describe('calculatePctWireless', () => {
    it('returns 0 for empty array', () => {
      expect(calculatePctWireless([])).toBe(0);
    });

    it('returns 100 when all leads have wireless', () => {
      const leads = [
        createLead({ wireless_phones: '555' }),
        createLead({ wireless_phones: '666' }),
      ];
      expect(calculatePctWireless(leads)).toBe(100);
    });

    it('returns 0 when no leads have wireless', () => {
      const leads = [
        createLead({ wireless_phones: '' }),
        createLead({ wireless_phones: '' }),
      ];
      expect(calculatePctWireless(leads)).toBe(0);
    });

    it('returns correct percentage for mixed', () => {
      const leads = [
        createLead({ wireless_phones: '555' }),
        createLead({ wireless_phones: '' }),
        createLead({ wireless_phones: '666' }),
        createLead({ wireless_phones: '' }),
      ];
      expect(calculatePctWireless(leads)).toBe(50);
    });
  });

  describe('calculatePctWithAddress', () => {
    it('returns 0 for empty array', () => {
      expect(calculatePctWithAddress([])).toBe(0);
    });

    it('returns 100 when all leads have full address', () => {
      const leads = [
        createLead({ address: '123 St', city: 'Miami', state: 'FL', zip: '33101' }),
        createLead({ address: '456 Ave', city: 'Tampa', state: 'FL', zip: '33602' }),
      ];
      expect(calculatePctWithAddress(leads)).toBe(100);
    });

    it('returns 0 when no leads have full address', () => {
      const leads = [
        createLead({ address: '', city: '', state: '', zip: '' }),
        createLead({ address: '123 St', city: '', state: '', zip: '' }),
      ];
      expect(calculatePctWithAddress(leads)).toBe(0);
    });

    it('requires all fields for full address', () => {
      const leads = [
        createLead({ address: '123 St', city: 'Miami', state: 'FL', zip: '33101' }),
        createLead({ address: '456 Ave', city: 'Tampa', state: 'FL', zip: '' }), // Missing zip
      ];
      expect(calculatePctWithAddress(leads)).toBe(50);
    });
  });

  describe('calculateMatchScoreDistribution', () => {
    it('returns zeros for empty array', () => {
      const dist = calculateMatchScoreDistribution([]);
      expect(dist).toEqual({
        score_0: 0,
        score_1: 0,
        score_2: 0,
        score_3: 0,
        score_4: 0,
        score_5_plus: 0,
      });
    });

    it('counts match scores correctly', () => {
      const leads = [
        createLead({ match_score: 0 }),
        createLead({ match_score: 1 }),
        createLead({ match_score: 2 }),
        createLead({ match_score: 3 }),
        createLead({ match_score: 4 }),
        createLead({ match_score: 5 }),
        createLead({ match_score: 6 }),
        createLead({ match_score: 10 }),
      ];

      const dist = calculateMatchScoreDistribution(leads);

      expect(dist.score_0).toBe(1);
      expect(dist.score_1).toBe(1);
      expect(dist.score_2).toBe(1);
      expect(dist.score_3).toBe(1);
      expect(dist.score_4).toBe(1);
      expect(dist.score_5_plus).toBe(3); // scores 5, 6, 10
    });

    it('handles undefined match_score as 0', () => {
      const leads = [
        createLead({ match_score: undefined as unknown as number }),
      ];

      const dist = calculateMatchScoreDistribution(leads);
      expect(dist.score_0).toBe(1);
    });
  });

  describe('generateQualityReport', () => {
    it('generates complete report', () => {
      const leads = [
        createLead({
          quality_score: 80,
          match_score: 5,
          wireless_phones: '555',
          address: '123 St',
          city: 'Miami',
          state: 'FL',
          zip: '33101',
        }),
        createLead({
          quality_score: 70,
          match_score: 4,
          wireless_phones: '',
          address: '456 Ave',
          city: 'Tampa',
          state: 'FL',
          zip: '33602',
        }),
      ];

      const report = generateQualityReport(leads, 3, 50, 10, 'balanced');

      expect(report.deliveredCount).toBe(2);
      expect(report.rejectedByQualityCount).toBe(3);
      expect(report.minQualityScoreUsed).toBe(50);
      expect(report.avgQualityScore).toBe(75);
      expect(report.pctWireless).toBe(50);
      expect(report.pctWithAddress).toBe(100);
      expect(report.warning).toContain('Delivered 2 of 10 requested');
    });

    it('returns zeros for empty leads', () => {
      const report = generateQualityReport([], 5, 50, 10, 'balanced');

      expect(report.deliveredCount).toBe(0);
      expect(report.avgQualityScore).toBe(0);
      expect(report.p90QualityScore).toBe(0);
      expect(report.pctWireless).toBe(0);
      expect(report.pctWithAddress).toBe(0);
    });

    it('does not include warning when delivered >= requested', () => {
      const leads = [
        createLead({ quality_score: 80 }),
        createLead({ quality_score: 70 }),
      ];

      const report = generateQualityReport(leads, 0, 50, 2, 'balanced');

      expect(report.warning).toBeUndefined();
    });
  });

  describe('getTierLabel', () => {
    it('returns correct label for hot tier', () => {
      expect(getTierLabel('hot')).toBe('Hot (≥70)');
    });

    it('returns correct label for balanced tier', () => {
      expect(getTierLabel('balanced')).toBe('Balanced (≥50)');
    });

    it('returns correct label for scale tier', () => {
      expect(getTierLabel('scale')).toBe('Scale (≥30)');
    });
  });
});
