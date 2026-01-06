import { describe, it, expect } from 'vitest';
import { mapAudienceLabContactToLead, lookupZipLocation } from '../../../api/_lib/providers/audiencelab';
import type { GenerateInput } from '../../../api/_lib/types';

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

  it('excludes contacts with no phone or email', () => {
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
