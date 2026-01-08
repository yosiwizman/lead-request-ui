import { describe, it, expect } from 'vitest';
import { mapAudienceLabContactToLead, lookupZipLocation, computeContactsCoverage, computeLeadsCoverage, buildRecipe, evaluateMatchByTier, getField, parseName, parsePhoneList, parseAllPhones, tierToNumericScore, emptyMatchScoreDistribution } from '../../../api/_lib/providers/audiencelab';
import type { GenerateInput, Lead } from '../../../api/_lib/types';

describe('lookupZipLocation', () => {
  it('returns city/state for known ZIP', () => {
    const result = lookupZipLocation('33101');
    expect(result).toEqual({ city: 'Miami', state: 'FL' });
  });

  it('returns null for unknown ZIP', () => {
    const result = lookupZipLocation('99999');
    expect(result).toBeNull();
  });

  it('handles various known ZIPs', () => {
    expect(lookupZipLocation('90210')).toEqual({ city: 'Beverly Hills', state: 'CA' });
    expect(lookupZipLocation('10001')).toEqual({ city: 'New York', state: 'NY' });
    expect(lookupZipLocation('60601')).toEqual({ city: 'Chicago', state: 'IL' });
  });
});

describe('mapAudienceLabContactToLead', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'both',
  };

  it('maps full AudienceLab contact to Lead', () => {
    const contact = {
      first_name: 'John',
      last_name: 'Doe',
      email: 'john.doe@example.com',
      phone: '3055551234', // US phone number
      address: '123 Main St',
      city: 'Miami',
      state: 'FL',
      zip: '33101',
    };

    const result = mapAudienceLabContactToLead(contact, baseInput, 0);

    expect(result.excluded).toBeNull();
    expect(result.lead).not.toBeNull();
    expect(result.lead!.first_name).toBe('John');
    expect(result.lead!.last_name).toBe('Doe');
    expect(result.lead!.email).toBe('john.doe@example.com');
    expect(result.lead!.phone).toBe('+13055551234'); // Normalized to E.164
    expect(result.lead!.address).toBe('123 Main St');
    expect(result.lead!.city).toBe('Miami');
    expect(result.lead!.state).toBe('FL');
    expect(result.lead!.zip).toBe('33101');
    expect(result.lead!.lead_type).toBe('residential');
    expect(result.lead!.tags).toBe('roofing');
    expect(result.lead!.source).toBe('audiencelab');
  });

  it('uses alternative field names when primary fields missing', () => {
    const contact = {
      first_name: 'Jane',
      last_name: 'Smith',
      mobile_phone: '3055555678', // US phone via mobile_phone field
      street_address: '456 Oak Ave',
      postal_code: '33130',
    };

    const result = mapAudienceLabContactToLead(contact, baseInput, 0);

    expect(result.lead).not.toBeNull();
    expect(result.lead!.phone).toBe('+13055555678'); // Normalized to E.164
    expect(result.lead!.address).toBe('456 Oak Ave');
    expect(result.lead!.zip).toBe('33130');
  });

  it('excludes contacts with no phone or email for useCase=both', () => {
    const contact = {};

    const result = mapAudienceLabContactToLead(contact, baseInput, 0);

    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('missing_contact');
  });

  it('uses scope from input for lead_type when residential', () => {
    const contact = { first_name: 'Test', email: 'test@example.com' };
    const residentialInput: GenerateInput = {
      leadRequest: 'hvac',
      zips: ['90210'],
      scope: 'residential',
    };

    const result = mapAudienceLabContactToLead(contact, residentialInput, 0);

    expect(result.lead!.lead_type).toBe('residential');
  });

  it('uses scope from input for lead_type when commercial', () => {
    const contact = { first_name: 'Test', email: 'test@example.com' };
    const commercialInput: GenerateInput = {
      leadRequest: 'hvac',
      zips: ['90210'],
      scope: 'commercial',
    };

    const result = mapAudienceLabContactToLead(contact, commercialInput, 0);

    expect(result.lead!.lead_type).toBe('commercial');
  });

  it('alternates lead_type when scope is both', () => {
    const contact = { first_name: 'Test', email: 'test@example.com' };
    const bothInput: GenerateInput = {
      leadRequest: 'solar',
      zips: ['10001'],
      scope: 'both',
    };

    // Even index should be residential
    const result0 = mapAudienceLabContactToLead(contact, bothInput, 0);
    expect(result0.lead!.lead_type).toBe('residential');

    // Odd index should be commercial
    const result1 = mapAudienceLabContactToLead(contact, bothInput, 1);
    expect(result1.lead!.lead_type).toBe('commercial');

    // Even index again
    const result2 = mapAudienceLabContactToLead(contact, bothInput, 2);
    expect(result2.lead!.lead_type).toBe('residential');
  });

  it('includes leadRequest in tags', () => {
    const contact = { first_name: 'Test', phone: '3055551111' };
    const input: GenerateInput = {
      leadRequest: 'plumbing services miami',
      zips: ['33101'],
      scope: 'residential',
    };

    const result = mapAudienceLabContactToLead(contact, input, 0);

    expect(result.lead!.tags).toBe('plumbing services miami');
  });

  it('excludes contacts with DNC=Y in residential scope', () => {
    const contact = { first_name: 'Test', email: 'test@example.com', DNC: 'Y' };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('dnc');
  });

  it('does not exclude DNC=Y in commercial scope', () => {
    const contact = { first_name: 'Test', email: 'test@example.com', DNC: 'Y' };
    const commercialInput: GenerateInput = { ...baseInput, scope: 'commercial' };
    const result = mapAudienceLabContactToLead(contact, commercialInput, 0);
    expect(result.lead).not.toBeNull();
  });
});

describe('mapAudienceLabContactToLead with useCase filtering', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'both',
  };

  it('useCase=call: excludes contacts without phone (when minMatchScore=0)', () => {
    const contact = { first_name: 'Test', email: 'test@example.com' };
    const input: GenerateInput = { ...baseInput, useCase: 'call' };
    // Pass minMatchScore=0 to test phone filtering without match score filtering
    const result = mapAudienceLabContactToLead(contact, input, 0, 0);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('missing_phone');
  });

  it('useCase=call: includes contacts with phone and high match score', () => {
    const contact = { 
      first_name: 'Test', 
      phone: '3055551234',
      SKIPTRACE_MATCH_BY: 'ADDRESS,EMAIL', // High tier for default minMatchScore=3
    };
    const input: GenerateInput = { ...baseInput, useCase: 'call' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.phone).toBe('+13055551234');
  });

  it('useCase=call: includes contacts with phone when minMatchScore=0', () => {
    const contact = { first_name: 'Test', phone: '3055551234' };
    const input: GenerateInput = { ...baseInput, useCase: 'call' };
    // Pass minMatchScore=0 to disable score filtering
    const result = mapAudienceLabContactToLead(contact, input, 0, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.phone).toBe('+13055551234');
  });

  it('useCase=email: excludes contacts without email', () => {
    const contact = { first_name: 'Test', phone: '3055551234' };
    const input: GenerateInput = { ...baseInput, useCase: 'email' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('invalid_email');
  });

  it('useCase=email: includes contacts with Valid(Esp) email', () => {
    const contact = {
      first_name: 'Test',
      PERSONAL_EMAIL: 'test@example.com',
      PERSONAL_EMAIL_VALIDATION_STATUS: 'Valid (Esp)',
    };
    const input: GenerateInput = { ...baseInput, useCase: 'email' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.email).toBe('test@example.com');
  });

  it('useCase=both: includes contacts with only phone', () => {
    const contact = { first_name: 'Test', phone: '3055551234' };
    const input: GenerateInput = { ...baseInput, useCase: 'both' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).not.toBeNull();
  });

  it('useCase=both: includes contacts with only email', () => {
    const contact = { first_name: 'Test', email: 'test@example.com' };
    const input: GenerateInput = { ...baseInput, useCase: 'both' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).not.toBeNull();
  });

  it('tracks missingNameOrAddress flag', () => {
    const contact = { phone: '3055551234' }; // no name, no address
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.missingNameOrAddress).toBe(true);
  });

  it('missingNameOrAddress is false when name and address present', () => {
    const contact = { first_name: 'Test', address: '123 Main St', phone: '3055551234' };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.missingNameOrAddress).toBe(false);
  });
});

describe('computeContactsCoverage', () => {
  it('returns zero coverage for empty array', () => {
    const result = computeContactsCoverage([], 'residential');
    
    expect(result.total).toBe(0);
    expect(result.present.first_name).toBe(0);
    expect(result.pct.first_name).toBe(0);
  });

  it('computes correct counts for contacts with all fields', () => {
    const contacts = [
      {
        first_name: 'John',
        last_name: 'Doe',
        address: '123 Main St',
        city: 'Miami',
        state: 'FL',
        zip: '33101',
        phone: '555-1234',
        email: 'john@example.com',
      },
      {
        first_name: 'Jane',
        last_name: 'Smith',
        address: '456 Oak Ave',
        city: 'Tampa',
        state: 'FL',
        zip: '33602',
        phone: '555-5678',
        email: 'jane@example.com',
      },
    ];

    const result = computeContactsCoverage(contacts, 'residential');
    
    expect(result.total).toBe(2);
    expect(result.present.first_name).toBe(2);
    expect(result.present.last_name).toBe(2);
    expect(result.present.address).toBe(2);
    expect(result.present.phone).toBe(2);
    expect(result.present.email).toBe(2);
    expect(result.pct.first_name).toBe(100);
    expect(result.pct.phone).toBe(100);
  });

  it('computes correct percentages for partial coverage', () => {
    const contacts = [
      { first_name: 'John', phone: '555-1234' },
      { phone: '555-5678' }, // no name
      { first_name: 'Jane' }, // no phone
      {}, // empty
    ];

    const result = computeContactsCoverage(contacts, 'residential');
    
    expect(result.total).toBe(4);
    expect(result.present.first_name).toBe(2);
    expect(result.present.phone).toBe(2);
    expect(result.pct.first_name).toBe(50);
    expect(result.pct.phone).toBe(50);
    expect(result.pct.address).toBe(0);
    expect(result.pct.email).toBe(0);
  });

  it('uses B2B fields for commercial scope', () => {
    const contacts = [
      { BUSINESS_EMAIL: 'biz@company.com', SKIPTRACE_B2B_WIRELESS: '555-1111' },
      { email: 'personal@example.com', phone: '555-2222' }, // fallback fields
    ];

    const result = computeContactsCoverage(contacts, 'commercial');
    
    expect(result.total).toBe(2);
    expect(result.present.email).toBe(2);
    expect(result.present.phone).toBe(2);
    expect(result.pct.email).toBe(100);
  });

  it('uses B2C fields for residential scope', () => {
    const contacts = [
      { PERSONAL_EMAIL: 'personal@example.com', SKIPTRACE_WIRELESS_NUMBERS: '555-1111' },
      { email: 'fallback@example.com', mobile_phone: '555-2222' },
    ];

    const result = computeContactsCoverage(contacts, 'residential');
    
    expect(result.total).toBe(2);
    expect(result.present.email).toBe(2);
    expect(result.present.phone).toBe(2);
  });

  it('detects address from alternate fields', () => {
    const contacts = [
      { street_address: '123 Street' },
      { address: '456 Ave' },
      { COMPANY_ADDRESS: '789 Corp Blvd' }, // Only counted in commercial scope
    ];

    const residentialResult = computeContactsCoverage(contacts, 'residential');
    expect(residentialResult.present.address).toBe(2); // street_address + address

    const commercialResult = computeContactsCoverage(contacts, 'commercial');
    expect(commercialResult.present.address).toBe(3); // all three
  });

  it('does NOT log any PII (verify no personal data in result)', () => {
    const contacts = [
      {
        first_name: 'SECRET_FIRST_NAME',
        last_name: 'SECRET_LAST_NAME',
        email: 'secret@email.com',
        phone: '555-SECRET',
        address: 'SECRET ADDRESS',
      },
    ];

    const result = computeContactsCoverage(contacts, 'residential');
    
    // Result should only contain counts, not actual values
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('SECRET');
    expect(resultStr).not.toContain('email.com');
    
    // Verify structure has no PII fields
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('present');
    expect(result).toHaveProperty('pct');
    expect(typeof result.present.first_name).toBe('number');
    expect(typeof result.pct.first_name).toBe('number');
  });
});

describe('computeLeadsCoverage', () => {
  it('returns zero coverage for empty array', () => {
    const result = computeLeadsCoverage([]);
    
    expect(result.total).toBe(0);
    expect(result.present.first_name).toBe(0);
    expect(result.pct.first_name).toBe(0);
  });

  it('computes correct counts for leads', () => {
    const leads: Lead[] = [
      {
        first_name: 'John',
        last_name: 'Doe',
        address: '123 Main St',
        city: 'Miami',
        state: 'FL',
        zip: '33101',
        phone: '555-1234',
        email: 'john@example.com',
        lead_type: 'residential',
        tags: 'roofing',
        source: 'audiencelab',
        best_phone: '555-1234',
        phones_all: '555-1234',
        wireless_phones: '555-1234',
        landline_phones: '',
        match_score: 3,
      },
      {
        first_name: '',
        last_name: '',
        address: '',
        city: '',
        state: '',
        zip: '',
        phone: '555-5678',
        email: '',
        lead_type: 'residential',
        tags: 'roofing',
        source: 'audiencelab',
        best_phone: '555-5678',
        phones_all: '555-5678',
        wireless_phones: '555-5678',
        landline_phones: '',
        match_score: 3,
      },
    ];

    const result = computeLeadsCoverage(leads);
    
    expect(result.total).toBe(2);
    expect(result.present.first_name).toBe(1);
    expect(result.present.phone).toBe(2);
    expect(result.pct.first_name).toBe(50);
    expect(result.pct.phone).toBe(100);
    expect(result.pct.email).toBe(50);
  });

  it('does NOT include PII in result', () => {
    const leads: Lead[] = [
      {
        first_name: 'SECRET_NAME',
        last_name: 'SECRET_LAST',
        address: 'SECRET_ADDR',
        city: 'SECRET_CITY',
        state: 'SS',
        zip: '99999',
        phone: 'SECRET_PHONE',
        email: 'secret@domain.com',
        lead_type: 'residential',
        tags: 'test',
        source: 'audiencelab',
        best_phone: 'SECRET_PHONE',
        phones_all: 'SECRET_PHONE',
        wireless_phones: 'SECRET_PHONE',
        landline_phones: '',
        match_score: 3,
      },
    ];

    const result = computeLeadsCoverage(leads);
    const resultStr = JSON.stringify(result);
    
    expect(resultStr).not.toContain('SECRET');
    expect(resultStr).not.toContain('domain.com');
    expect(resultStr).not.toContain('99999');
  });
});

// =============================================================================
// RECIPE ENGINE TESTS
// =============================================================================

describe('buildRecipe', () => {
  it('builds call recipe for B2C with DNC exclusion', () => {
    const recipe = buildRecipe('residential', 'call');
    
    expect(recipe.requirePhone).toBe(true);
    expect(recipe.requireEmailValidEsp).toBe(false);
    expect(recipe.excludeDnc).toBe(true);
    expect(recipe.freshnessDays).toBe(0);
  });

  it('builds call recipe for B2B without DNC exclusion', () => {
    const recipe = buildRecipe('commercial', 'call');
    
    expect(recipe.requirePhone).toBe(true);
    expect(recipe.excludeDnc).toBe(false);
  });

  it('builds email recipe with Valid(Esp) requirement and freshness', () => {
    const recipe = buildRecipe('residential', 'email');
    
    expect(recipe.requireEmailValidEsp).toBe(true);
    expect(recipe.requirePhone).toBe(false);
    expect(recipe.freshnessDays).toBe(30);
  });

  it('builds both recipe with DNC exclusion for B2C', () => {
    const recipe = buildRecipe('residential', 'both');
    
    expect(recipe.requirePhone).toBe(false);
    expect(recipe.requireEmailValidEsp).toBe(false);
    expect(recipe.excludeDnc).toBe(true);
    expect(recipe.freshnessDays).toBe(0);
  });
});

describe('evaluateMatchByTier', () => {
  it('returns high tier for ADDRESS + EMAIL match', () => {
    const contact = { SKIPTRACE_MATCH_BY: 'ADDRESS,EMAIL' };
    expect(evaluateMatchByTier(contact, 'residential')).toBe('high');
  });

  it('returns high tier for B2B COMPANY_ADDRESS + EMAIL', () => {
    const contact = { SKIPTRACE_B2B_MATCH_BY: 'COMPANY_ADDRESS,EMAIL' };
    expect(evaluateMatchByTier(contact, 'commercial')).toBe('high');
  });

  it('returns medium tier for NAME + ADDRESS match', () => {
    const contact = { SKIPTRACE_MATCH_BY: 'NAME,ADDRESS' };
    expect(evaluateMatchByTier(contact, 'residential')).toBe('medium');
  });

  it('returns low tier for other match methods', () => {
    const contact = { SKIPTRACE_MATCH_BY: 'PHONE' };
    expect(evaluateMatchByTier(contact, 'residential')).toBe('low');
  });

  it('returns low tier when no match_by field', () => {
    const contact = {};
    expect(evaluateMatchByTier(contact, 'residential')).toBe('low');
  });

  it('is case-insensitive', () => {
    const contact = { SKIPTRACE_MATCH_BY: 'address,email' };
    expect(evaluateMatchByTier(contact, 'residential')).toBe('high');
  });
});

describe('Recipe Engine: Valid(Esp) email filtering', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'email',
  };

  it('accepts email with Valid (Esp) status', () => {
    const contact = {
      first_name: 'Test',
      PERSONAL_EMAIL: 'test@example.com',
      PERSONAL_EMAIL_VALIDATION_STATUS: 'Valid (Esp)',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.email).toBe('test@example.com');
  });

  it('rejects email without Valid (Esp) status for email useCase', () => {
    const contact = {
      first_name: 'Test',
      PERSONAL_EMAIL: 'test@example.com',
      PERSONAL_EMAIL_VALIDATION_STATUS: 'Valid', // Not Esp
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('invalid_email_esp');
  });

  it('rejects email with Invalid status', () => {
    const contact = {
      first_name: 'Test',
      PERSONAL_EMAIL: 'test@example.com',
      PERSONAL_EMAIL_VALIDATION_STATUS: 'Invalid',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('invalid_email_esp'); // Invalid != Valid(Esp)
  });
});

describe('Recipe Engine: LAST_SEEN freshness', () => {
  const emailInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'email',
  };

  it('accepts contact with recent LAST_SEEN', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 10); // 10 days ago
    
    const contact = {
      first_name: 'Test',
      PERSONAL_EMAIL: 'test@example.com',
      PERSONAL_EMAIL_VALIDATION_STATUS: 'Valid (Esp)',
      LAST_SEEN: recentDate.toISOString(),
    };
    const result = mapAudienceLabContactToLead(contact, emailInput, 0);
    
    expect(result.lead).not.toBeNull();
  });

  it('rejects contact with old LAST_SEEN for email useCase', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60); // 60 days ago (> 30 day window)
    
    const contact = {
      first_name: 'Test',
      PERSONAL_EMAIL: 'test@example.com',
      PERSONAL_EMAIL_VALIDATION_STATUS: 'Valid (Esp)',
      LAST_SEEN: oldDate.toISOString(),
    };
    const result = mapAudienceLabContactToLead(contact, emailInput, 0);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('email_too_old');
  });

  it('accepts contact without LAST_SEEN field', () => {
    const contact = {
      first_name: 'Test',
      PERSONAL_EMAIL: 'test@example.com',
      PERSONAL_EMAIL_VALIDATION_STATUS: 'Valid (Esp)',
      // No LAST_SEEN
    };
    const result = mapAudienceLabContactToLead(contact, emailInput, 0);
    
    expect(result.lead).not.toBeNull();
  });

  it('does not apply freshness check for call useCase', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    
    const contact = {
      first_name: 'Test',
      phone: '3055551234', // Valid 10-digit phone
      LAST_SEEN: oldDate.toISOString(),
      SKIPTRACE_MATCH_BY: 'ADDRESS,EMAIL', // High tier to pass default minMatchScore=3
    };
    const callInput: GenerateInput = { ...emailInput, useCase: 'call' };
    const result = mapAudienceLabContactToLead(contact, callInput, 0);
    
    expect(result.lead).not.toBeNull();
  });
});

describe('Recipe Engine: match_by tier in result', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'both',
  };

  it('includes tier in result for high accuracy contact', () => {
    const contact = {
      first_name: 'Test',
      email: 'test@example.com',
      SKIPTRACE_MATCH_BY: 'ADDRESS,EMAIL',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.tier).toBe('high');
  });

  it('includes tier in result for medium accuracy contact', () => {
    const contact = {
      first_name: 'Test',
      email: 'test@example.com',
      SKIPTRACE_MATCH_BY: 'NAME,ADDRESS',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.tier).toBe('medium');
  });

  it('includes tier in result for excluded contacts', () => {
    const contact = {
      // No phone or email - will be excluded
      SKIPTRACE_MATCH_BY: 'ADDRESS,EMAIL',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).toBeNull();
    expect(result.tier).toBe('high'); // Tier still computed
  });
});

// =============================================================================
// FIELD ACCESSOR & PARSING UTILITIES TESTS
// =============================================================================

describe('getField', () => {
  it('reads field from root level', () => {
    const contact = { first_name: 'John', email: 'john@example.com' };
    expect(getField(contact, 'first_name')).toBe('John');
    expect(getField(contact, 'email')).toBe('john@example.com');
  });

  it('reads field from nested fields object', () => {
    const contact = { fields: { SKIPTRACE_NAME: 'Jane Doe' } };
    expect(getField(contact, 'SKIPTRACE_NAME')).toBe('Jane Doe');
  });

  it('reads field from nested data object', () => {
    const contact = { data: { phone: '3055551234' } };
    expect(getField(contact, 'phone')).toBe('3055551234');
  });

  it('reads field from nested profile object', () => {
    const contact = { profile: { address: '123 Main St' } };
    expect(getField(contact, 'address')).toBe('123 Main St');
  });

  it('prefers root level over nested', () => {
    const contact = { 
      first_name: 'Root',
      fields: { first_name: 'Nested' }
    };
    expect(getField(contact, 'first_name')).toBe('Root');
  });

  it('returns undefined for missing field', () => {
    const contact = { first_name: 'Test' };
    expect(getField(contact, 'NONEXISTENT')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    const contact = { first_name: '' };
    expect(getField(contact, 'first_name')).toBeUndefined();
  });

  it('converts non-string values to string', () => {
    const contact = { count: 42 };
    expect(getField(contact, 'count')).toBe('42');
  });
});

describe('parseName', () => {
  it('parses full name into first and last', () => {
    const result = parseName('John Doe');
    expect(result.first_name).toBe('John');
    expect(result.last_name).toBe('Doe');
  });

  it('handles middle names', () => {
    const result = parseName('John Michael Doe');
    expect(result.first_name).toBe('John Michael');
    expect(result.last_name).toBe('Doe');
  });

  it('handles single name as first name', () => {
    const result = parseName('John');
    expect(result.first_name).toBe('John');
    expect(result.last_name).toBe('');
  });

  it('returns empty for undefined', () => {
    const result = parseName(undefined);
    expect(result.first_name).toBe('');
    expect(result.last_name).toBe('');
  });

  it('returns empty for empty string', () => {
    const result = parseName('');
    expect(result.first_name).toBe('');
    expect(result.last_name).toBe('');
  });

  it('trims whitespace', () => {
    const result = parseName('  John   Doe  ');
    expect(result.first_name).toBe('John');
    expect(result.last_name).toBe('Doe');
  });
});

describe('parsePhoneList', () => {
  it('normalizes 10-digit US phone to E.164', () => {
    expect(parsePhoneList('3055551234')).toBe('+13055551234');
  });

  it('normalizes 11-digit US phone with leading 1', () => {
    expect(parsePhoneList('13055551234')).toBe('+13055551234');
  });

  it('handles formatted phone number', () => {
    expect(parsePhoneList('(305) 555-1234')).toBe('+13055551234');
  });

  it('handles comma-separated list and returns first valid', () => {
    expect(parsePhoneList('3055551234,3055555678')).toBe('+13055551234');
  });

  it('handles pipe-separated list', () => {
    expect(parsePhoneList('3055551234|3055555678')).toBe('+13055551234');
  });

  it('handles semicolon-separated list', () => {
    expect(parsePhoneList('3055551234;3055555678')).toBe('+13055551234');
  });

  it('returns empty for undefined', () => {
    expect(parsePhoneList(undefined)).toBe('');
  });

  it('returns empty for empty string', () => {
    expect(parsePhoneList('')).toBe('');
  });

  it('passes through non-phone strings', () => {
    // Strings that don't look like phones are returned as-is
    expect(parsePhoneList('abc')).toBe('abc');
  });
});

// =============================================================================
// SKIPTRACE FIELD MAPPING TESTS
// =============================================================================

describe('SKIPTRACE field mapping', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'both',
  };

  it('maps SKIPTRACE_NAME to first/last name', () => {
    const contact = {
      SKIPTRACE_NAME: 'John Michael Doe',
      phone: '3055551234',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.first_name).toBe('John Michael');
    expect(result.lead!.last_name).toBe('Doe');
  });

  it('prefers SKIPTRACE_NAME over first_name/last_name', () => {
    const contact = {
      first_name: 'Online',
      last_name: 'Name',
      SKIPTRACE_NAME: 'Offline Name',
      phone: '3055551234',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead!.first_name).toBe('Offline');
    expect(result.lead!.last_name).toBe('Name');
  });

  it('falls back to first_name/last_name when SKIPTRACE_NAME missing', () => {
    const contact = {
      first_name: 'John',
      last_name: 'Doe',
      phone: '3055551234',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead!.first_name).toBe('John');
    expect(result.lead!.last_name).toBe('Doe');
  });

  it('maps SKIPTRACE_ADDRESS/CITY/STATE/ZIP fields', () => {
    const contact = {
      SKIPTRACE_ADDRESS: '123 Skiptrace St',
      SKIPTRACE_CITY: 'Skiptrace City',
      SKIPTRACE_STATE: 'SC',
      SKIPTRACE_ZIP: '12345',
      address: '456 Online St',
      city: 'Online City',
      state: 'OC',
      zip: '67890',
      phone: '3055551234',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead!.address).toBe('123 Skiptrace St');
    expect(result.lead!.city).toBe('Skiptrace City');
    expect(result.lead!.state).toBe('SC');
    expect(result.lead!.zip).toBe('12345');
  });

  it('falls back to online address fields when SKIPTRACE missing', () => {
    const contact = {
      address: '456 Online St',
      city: 'Online City',
      state: 'OC',
      zip: '67890',
      phone: '3055551234',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead!.address).toBe('456 Online St');
    expect(result.lead!.city).toBe('Online City');
    expect(result.lead!.state).toBe('OC');
    expect(result.lead!.zip).toBe('67890');
  });

  it('maps SKIPTRACE_WIRELESS_NUMBERS for B2C', () => {
    const contact = {
      SKIPTRACE_WIRELESS_NUMBERS: '3055551234,3055555678',
      phone: '9999999999',
      first_name: 'Test',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead!.phone).toBe('+13055551234'); // First from list
  });

  it('maps SKIPTRACE_B2B_WIRELESS for B2B', () => {
    const contact = {
      SKIPTRACE_B2B_WIRELESS: '3055551234',
      phone: '9999999999',
      first_name: 'Test',
    };
    const commercialInput: GenerateInput = { ...baseInput, scope: 'commercial' };
    const result = mapAudienceLabContactToLead(contact, commercialInput, 0);
    
    expect(result.lead!.phone).toBe('+13055551234');
  });

  it('reads fields from nested locations', () => {
    const contact = {
      fields: {
        SKIPTRACE_NAME: 'Nested Name',
        SKIPTRACE_WIRELESS_NUMBERS: '3055551234',
      },
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.first_name).toBe('Nested');
    expect(result.lead!.last_name).toBe('Name');
    expect(result.lead!.phone).toBe('+13055551234');
  });
});

// =============================================================================
// parseAllPhones TESTS
// =============================================================================

describe('parseAllPhones', () => {
  it('parses B2C wireless and landline numbers', () => {
    const contact = {
      SKIPTRACE_WIRELESS_NUMBERS: '3055551234,3055552222',
      SKIPTRACE_LANDLINE_NUMBERS: '3055553333',
    };
    const result = parseAllPhones(contact, 'residential');
    
    expect(result.wireless).toEqual(['+13055551234', '+13055552222']);
    expect(result.landline).toEqual(['+13055553333']);
    expect(result.all).toEqual(['+13055551234', '+13055552222', '+13055553333']);
    expect(result.best).toBe('+13055551234'); // First wireless
  });

  it('parses B2B wireless and landline numbers', () => {
    const contact = {
      SKIPTRACE_B2B_WIRELESS: '3055551234',
      SKIPTRACE_B2B_LANDLINE: '3055553333',
    };
    const result = parseAllPhones(contact, 'commercial');
    
    expect(result.wireless).toEqual(['+13055551234']);
    expect(result.landline).toEqual(['+13055553333']);
    expect(result.best).toBe('+13055551234');
  });

  it('deduplicates phone numbers', () => {
    const contact = {
      SKIPTRACE_WIRELESS_NUMBERS: '3055551234,3055551234', // Duplicate
      mobile_phone: '3055551234', // Same as above
    };
    const result = parseAllPhones(contact, 'residential');
    
    expect(result.all.length).toBe(1);
    expect(result.wireless).toEqual(['+13055551234']);
  });

  it('classifies mobile_phone as wireless', () => {
    const contact = {
      mobile_phone: '3055551234',
    };
    const result = parseAllPhones(contact, 'residential');
    
    expect(result.wireless).toEqual(['+13055551234']);
    expect(result.best).toBe('+13055551234');
  });

  it('classifies phone field as other', () => {
    const contact = {
      phone: '3055551234',
    };
    const result = parseAllPhones(contact, 'residential');
    
    expect(result.wireless).toEqual([]);
    expect(result.landline).toEqual([]);
    expect(result.all).toEqual(['+13055551234']);
  });

  it('returns empty arrays for contact with no phones', () => {
    const contact = {};
    const result = parseAllPhones(contact, 'residential');
    
    expect(result.wireless).toEqual([]);
    expect(result.landline).toEqual([]);
    expect(result.all).toEqual([]);
    expect(result.best).toBe('');
  });

  it('prefers wireless over landline for best phone', () => {
    const contact = {
      SKIPTRACE_LANDLINE_NUMBERS: '3055553333',
      SKIPTRACE_WIRELESS_NUMBERS: '3055551234', // Added after landline
    };
    const result = parseAllPhones(contact, 'residential');
    
    expect(result.best).toBe('+13055551234'); // Wireless preferred
  });
});

// =============================================================================
// tierToNumericScore TESTS
// =============================================================================

describe('tierToNumericScore', () => {
  it('returns 3 for high tier', () => {
    expect(tierToNumericScore('high')).toBe(3);
  });

  it('returns 2 for medium tier', () => {
    expect(tierToNumericScore('medium')).toBe(2);
  });

  it('returns 1 for low tier', () => {
    expect(tierToNumericScore('low')).toBe(1);
  });

  it('returns 0 for null', () => {
    expect(tierToNumericScore(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(tierToNumericScore(undefined)).toBe(0);
  });
});

// =============================================================================
// emptyMatchScoreDistribution TESTS
// =============================================================================

describe('emptyMatchScoreDistribution', () => {
  it('returns all zeros', () => {
    const result = emptyMatchScoreDistribution();
    expect(result).toEqual({ score0: 0, score1: 0, score2: 0, score3: 0 });
  });
});

// =============================================================================
// minMatchScore filtering TESTS
// =============================================================================

describe('minMatchScore filtering', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'call',
  };

  it('filters contacts with low match score when minMatchScore=3', () => {
    const contact = {
      phone: '3055551234',
      SKIPTRACE_MATCH_BY: 'PHONE', // Low tier
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0, 3);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('low_match_score');
    expect(result.matchScore).toBe(1);
  });

  it('accepts high tier contact when minMatchScore=3', () => {
    const contact = {
      phone: '3055551234',
      SKIPTRACE_MATCH_BY: 'ADDRESS,EMAIL', // High tier
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0, 3);
    
    expect(result.lead).not.toBeNull();
    expect(result.matchScore).toBe(3);
  });

  it('accepts medium tier contact when minMatchScore=2', () => {
    const contact = {
      phone: '3055551234',
      SKIPTRACE_MATCH_BY: 'NAME,ADDRESS', // Medium tier
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0, 2);
    
    expect(result.lead).not.toBeNull();
    expect(result.matchScore).toBe(2);
  });

  it('accepts all contacts when minMatchScore=0', () => {
    const contact = {
      phone: '3055551234',
      // No SKIPTRACE_MATCH_BY = low tier
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.matchScore).toBe(1); // Low tier
  });

  it('includes match_score in lead object', () => {
    const contact = {
      phone: '3055551234',
      SKIPTRACE_MATCH_BY: 'ADDRESS,EMAIL',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.match_score).toBe(3);
  });
});

// =============================================================================
// Dialer-friendly phone fields TESTS
// =============================================================================

describe('Dialer-friendly phone fields', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
    useCase: 'both',
  };

  it('populates all phone fields in lead', () => {
    const contact = {
      SKIPTRACE_WIRELESS_NUMBERS: '3055551234,3055552222',
      SKIPTRACE_LANDLINE_NUMBERS: '3055553333',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.phone).toBe('+13055551234');
    expect(result.lead!.best_phone).toBe('+13055551234');
    expect(result.lead!.phones_all).toBe('+13055551234|+13055552222|+13055553333');
    expect(result.lead!.wireless_phones).toBe('+13055551234|+13055552222');
    expect(result.lead!.landline_phones).toBe('+13055553333');
  });

  it('handles empty phone fields', () => {
    const contact = {
      email: 'test@example.com',
    };
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.phones_all).toBe('');
    expect(result.lead!.wireless_phones).toBe('');
    expect(result.lead!.landline_phones).toBe('');
  });
});

// =============================================================================
// buildRecipe minMatchScore TESTS
// =============================================================================

describe('buildRecipe minMatchScore', () => {
  it('defaults minMatchScore to 3 for call useCase', () => {
    const recipe = buildRecipe('residential', 'call');
    expect(recipe.minMatchScore).toBe(3);
  });

  it('defaults minMatchScore to 0 for email useCase', () => {
    const recipe = buildRecipe('residential', 'email');
    expect(recipe.minMatchScore).toBe(0);
  });

  it('defaults minMatchScore to 0 for both useCase', () => {
    const recipe = buildRecipe('residential', 'both');
    expect(recipe.minMatchScore).toBe(0);
  });

  it('allows override of minMatchScore', () => {
    const recipe = buildRecipe('residential', 'call', 1);
    expect(recipe.minMatchScore).toBe(1);
  });

  it('allows override to 0', () => {
    const recipe = buildRecipe('residential', 'call', 0);
    expect(recipe.minMatchScore).toBe(0);
  });
});
