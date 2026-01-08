import { describe, it, expect } from 'vitest';
import { buildAudiencePayload } from '../../../api/_lib/providers/audiencelab';
import type { GenerateInput, LeadScope, UseCase } from '../../../api/_lib/types';

describe('buildAudiencePayload', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing repair',
    zips: ['33101', '33130'],
    scope: 'residential' as LeadScope,
    useCase: 'call' as UseCase,
  };

  describe('basic structure', () => {
    it('returns a properly structured payload', () => {
      const payload = buildAudiencePayload(baseInput);
      
      expect(payload).toHaveProperty('name');
      expect(payload).toHaveProperty('description');
      expect(payload).toHaveProperty('persona_type');
      expect(payload).toHaveProperty('size');
      expect(payload).toHaveProperty('filters');
    });

    it('includes lead request in name and description', () => {
      const payload = buildAudiencePayload(baseInput);
      
      expect(payload.name).toContain('Lead Request:');
      expect(payload.name).toContain('roofing repair');
      expect(payload.description).toBe('roofing repair');
    });

    it('truncates long lead requests in name to 50 chars', () => {
      const longRequest = 'a'.repeat(100);
      const input = { ...baseInput, leadRequest: longRequest };
      const payload = buildAudiencePayload(input);
      
      const name = payload.name as string;
      expect(name.length).toBeLessThanOrEqual('Lead Request: '.length + 50);
    });
  });

  describe('persona type (B2B/B2C)', () => {
    it('sets persona_type to B2C for residential scope', () => {
      const input = { ...baseInput, scope: 'residential' as LeadScope };
      const payload = buildAudiencePayload(input);
      
      expect(payload.persona_type).toBe('B2C');
    });

    it('sets persona_type to B2B for commercial scope', () => {
      const input = { ...baseInput, scope: 'commercial' as LeadScope };
      const payload = buildAudiencePayload(input);
      
      expect(payload.persona_type).toBe('B2B');
    });

    it('sets persona_type to B2C for "both" scope (defaults to residential)', () => {
      const input = { ...baseInput, scope: 'both' as LeadScope };
      const payload = buildAudiencePayload(input);
      
      // 'both' is not 'commercial', so should be B2C
      expect(payload.persona_type).toBe('B2C');
    });
  });

  describe('size and requestedCount', () => {
    it('uses default size of 200 when requestedCount not provided', () => {
      const payload = buildAudiencePayload(baseInput);
      
      expect(payload.size).toBe(200);
    });

    it('uses provided requestedCount', () => {
      const input = { ...baseInput, requestedCount: 500 };
      const payload = buildAudiencePayload(input as GenerateInput);
      
      expect(payload.size).toBe(500);
    });

    it('caps size at 1000 even if requestedCount is higher', () => {
      const input = { ...baseInput, requestedCount: 2000 };
      const payload = buildAudiencePayload(input as GenerateInput);
      
      expect(payload.size).toBe(1000);
    });

    it('enforces minimum size of 1', () => {
      const input = { ...baseInput, requestedCount: 0 };
      const payload = buildAudiencePayload(input as GenerateInput);
      
      expect(payload.size).toBe(1);
    });
  });

  describe('intent filters', () => {
    it('includes keywords from leadRequest', () => {
      const payload = buildAudiencePayload(baseInput);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.keywords).toBe('roofing repair');
    });

    it('includes intent_strength for meaningful intent targeting', () => {
      const payload = buildAudiencePayload(baseInput);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.intent_strength).toEqual(['high', 'medium']);
    });
  });

  describe('geographic filters', () => {
    it('includes zip_codes from input', () => {
      const payload = buildAudiencePayload(baseInput);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.zip_codes).toEqual(['33101', '33130']);
    });

    it('includes location hints for known ZIP codes', () => {
      const payload = buildAudiencePayload(baseInput);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.locations).toBeDefined();
      const locations = filters.locations as Array<{ city?: string; state?: string; zip?: string }>;
      
      // Should include Miami, FL for 33101
      const miami = locations.find(l => l.zip === '33101');
      expect(miami).toBeDefined();
      expect(miami?.city).toBe('Miami');
      expect(miami?.state).toBe('FL');
    });

    it('handles unknown ZIP codes gracefully', () => {
      const input = { ...baseInput, zips: ['99999', '88888'] };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.zip_codes).toEqual(['99999', '88888']);
      expect(filters.locations).toBeDefined();
      
      // Should still include zip-only entries for unknown zips
      const locations = filters.locations as Array<{ city?: string; state?: string; zip?: string }>;
      expect(locations.some(l => l.zip === '99999')).toBe(true);
    });
  });

  describe('contact filters for call useCase', () => {
    it('requires phone for call useCase', () => {
      const input = { ...baseInput, useCase: 'call' as UseCase };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.phone_required).toBe(true);
      expect(filters.skip_trace_phone_required).toBe(true);
      expect(filters.wireless_phone_required).toBe(true);
    });

    it('requires clean DNC status for call useCase', () => {
      const input = { ...baseInput, useCase: 'call' as UseCase };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.dnc_status).toBe('clean');
    });

    it('uses default minMatchScore of 3 for call useCase', () => {
      const input = { ...baseInput, useCase: 'call' as UseCase };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.min_match_score).toBe(3);
    });

    it('uses provided minMatchScore override for call useCase', () => {
      const input = { ...baseInput, useCase: 'call' as UseCase, minMatchScore: 2 };
      const payload = buildAudiencePayload(input as GenerateInput);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.min_match_score).toBe(2);
    });
  });

  describe('contact filters for email useCase', () => {
    it('requires valid email for email useCase', () => {
      const input = { ...baseInput, useCase: 'email' as UseCase };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.email_required).toBe(true);
      expect(filters.email_validation_status).toBe('valid');
    });

    it('does not require phone for email useCase', () => {
      const input = { ...baseInput, useCase: 'email' as UseCase };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.phone_required).toBeUndefined();
      expect(filters.skip_trace_phone_required).toBeUndefined();
    });

    it('does not require DNC clean status for email useCase', () => {
      const input = { ...baseInput, useCase: 'email' as UseCase };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.dnc_status).toBeUndefined();
    });

    it('does not require min_match_score by default for email useCase', () => {
      const input = { ...baseInput, useCase: 'email' as UseCase };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.min_match_score).toBeUndefined();
    });

    it('uses provided minMatchScore for email useCase when specified', () => {
      const input = { ...baseInput, useCase: 'email' as UseCase, minMatchScore: 2 };
      const payload = buildAudiencePayload(input as GenerateInput);
      const filters = payload.filters as Record<string, unknown>;
      
      expect(filters.min_match_score).toBe(2);
    });
  });

  describe('contact filters for both useCase', () => {
    it('defaults to call filters when useCase not specified', () => {
      const input: GenerateInput = {
        leadRequest: 'roofing',
        zips: ['33101'],
        scope: 'residential',
        // No useCase specified
      };
      const payload = buildAudiencePayload(input);
      const filters = payload.filters as Record<string, unknown>;
      
      // Should default to call-style filters
      expect(filters.phone_required).toBe(true);
      expect(filters.dnc_status).toBe('clean');
    });
  });

  describe('full payload integration', () => {
    it('generates a valid AudienceLab payload for residential call leads', () => {
      const input: GenerateInput = {
        leadRequest: 'roof replacement quotes',
        zips: ['33101', '33130', '33139'],
        scope: 'residential',
        useCase: 'call',
      };
      
      const payload = buildAudiencePayload(input);
      
      expect(payload).toMatchObject({
        name: expect.stringContaining('Lead Request:'),
        description: 'roof replacement quotes',
        persona_type: 'B2C',
        size: 200,
        filters: {
          keywords: 'roof replacement quotes',
          intent_strength: ['high', 'medium'],
          zip_codes: ['33101', '33130', '33139'],
          phone_required: true,
          skip_trace_phone_required: true,
          wireless_phone_required: true,
          dnc_status: 'clean',
          min_match_score: 3,
        },
      });
    });

    it('generates a valid AudienceLab payload for commercial email leads', () => {
      const input: GenerateInput = {
        leadRequest: 'commercial hvac services',
        zips: ['10001', '10002'],
        scope: 'commercial',
        useCase: 'email',
      };
      
      const payload = buildAudiencePayload(input);
      
      expect(payload).toMatchObject({
        persona_type: 'B2B',
        filters: {
          keywords: 'commercial hvac services',
          email_required: true,
          email_validation_status: 'valid',
        },
      });
      
      // Should NOT have phone-related filters
      const filters = payload.filters as Record<string, unknown>;
      expect(filters.phone_required).toBeUndefined();
      expect(filters.dnc_status).toBeUndefined();
    });
  });
});
