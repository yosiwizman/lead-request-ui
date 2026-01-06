import { describe, it, expect } from 'vitest';
import { mapAudienceLabContactToLead, lookupZipLocation, computeContactsCoverage, computeLeadsCoverage } from '../../../api/_lib/providers/audiencelab';
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
      phone: '305-555-1234',
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
    expect(result.lead!.phone).toBe('305-555-1234');
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
      mobile_phone: '305-555-5678',
      street_address: '456 Oak Ave',
      postal_code: '33130',
    };

    const result = mapAudienceLabContactToLead(contact, baseInput, 0);

    expect(result.lead).not.toBeNull();
    expect(result.lead!.phone).toBe('305-555-5678');
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
    const contact = { first_name: 'Test', phone: '305-555-1234' };
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

  it('useCase=call: excludes contacts without phone', () => {
    const contact = { first_name: 'Test', email: 'test@example.com' };
    const input: GenerateInput = { ...baseInput, useCase: 'call' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('missing_phone');
  });

  it('useCase=call: includes contacts with phone', () => {
    const contact = { first_name: 'Test', phone: '************' };
    const input: GenerateInput = { ...baseInput, useCase: 'call' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.phone).toBe('************');
  });

  it('useCase=email: excludes contacts without email', () => {
    const contact = { first_name: 'Test', phone: '************' };
    const input: GenerateInput = { ...baseInput, useCase: 'email' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).toBeNull();
    expect(result.excluded).toBe('invalid_email');
  });

  it('useCase=email: includes contacts with valid email', () => {
    const contact = { first_name: 'Test', email: 'test@example.com' };
    const input: GenerateInput = { ...baseInput, useCase: 'email' };
    const result = mapAudienceLabContactToLead(contact, input, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.lead!.email).toBe('test@example.com');
  });

  it('useCase=both: includes contacts with only phone', () => {
    const contact = { first_name: 'Test', phone: '************' };
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
    const contact = { phone: '************' }; // no name, no address
    const result = mapAudienceLabContactToLead(contact, baseInput, 0);
    
    expect(result.lead).not.toBeNull();
    expect(result.missingNameOrAddress).toBe(true);
  });

  it('missingNameOrAddress is false when name and address present', () => {
    const contact = { first_name: 'Test', address: '123 Main St', phone: '************' };
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
      },
    ];

    const result = computeLeadsCoverage(leads);
    const resultStr = JSON.stringify(result);
    
    expect(resultStr).not.toContain('SECRET');
    expect(resultStr).not.toContain('domain.com');
    expect(resultStr).not.toContain('99999');
  });
});
