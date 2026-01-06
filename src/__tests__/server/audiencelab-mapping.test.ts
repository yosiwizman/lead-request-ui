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

    const lead = mapAudienceLabContactToLead(contact, baseInput, 0);

    expect(lead.first_name).toBe('John');
    expect(lead.last_name).toBe('Doe');
    expect(lead.email).toBe('john.doe@example.com');
    expect(lead.phone).toBe('305-555-1234');
    expect(lead.address).toBe('123 Main St');
    expect(lead.city).toBe('Miami');
    expect(lead.state).toBe('FL');
    expect(lead.zip).toBe('33101');
    expect(lead.lead_type).toBe('residential');
    expect(lead.tags).toBe('roofing');
    expect(lead.source).toBe('audiencelab');
  });

  it('uses alternative field names when primary fields missing', () => {
    const contact = {
      first_name: 'Jane',
      last_name: 'Smith',
      mobile_phone: '305-555-9999',
      street_address: '456 Oak Ave',
      postal_code: '33130',
    };

    const lead = mapAudienceLabContactToLead(contact, baseInput, 0);

    expect(lead.phone).toBe('305-555-9999');
    expect(lead.address).toBe('456 Oak Ave');
    expect(lead.zip).toBe('33130');
  });

  it('handles missing fields gracefully', () => {
    const contact = {};

    const lead = mapAudienceLabContactToLead(contact, baseInput, 0);

    expect(lead.first_name).toBe('');
    expect(lead.last_name).toBe('');
    expect(lead.email).toBe('');
    expect(lead.phone).toBe('');
    expect(lead.address).toBe('');
    expect(lead.city).toBe('');
    expect(lead.state).toBe('');
    expect(lead.zip).toBe('');
    expect(lead.source).toBe('audiencelab');
  });

  it('uses scope from input for lead_type when residential', () => {
    const contact = { first_name: 'Test' };
    const residentialInput: GenerateInput = {
      leadRequest: 'hvac',
      zips: ['90210'],
      scope: 'residential',
    };

    const lead = mapAudienceLabContactToLead(contact, residentialInput, 0);

    expect(lead.lead_type).toBe('residential');
  });

  it('uses scope from input for lead_type when commercial', () => {
    const contact = { first_name: 'Test' };
    const commercialInput: GenerateInput = {
      leadRequest: 'hvac',
      zips: ['90210'],
      scope: 'commercial',
    };

    const lead = mapAudienceLabContactToLead(contact, commercialInput, 0);

    expect(lead.lead_type).toBe('commercial');
  });

  it('alternates lead_type when scope is both', () => {
    const contact = { first_name: 'Test' };
    const bothInput: GenerateInput = {
      leadRequest: 'solar',
      zips: ['10001'],
      scope: 'both',
    };

    // Even index should be residential
    const lead0 = mapAudienceLabContactToLead(contact, bothInput, 0);
    expect(lead0.lead_type).toBe('residential');

    // Odd index should be commercial
    const lead1 = mapAudienceLabContactToLead(contact, bothInput, 1);
    expect(lead1.lead_type).toBe('commercial');

    // Even index again
    const lead2 = mapAudienceLabContactToLead(contact, bothInput, 2);
    expect(lead2.lead_type).toBe('residential');
  });

  it('includes leadRequest in tags', () => {
    const contact = { first_name: 'Test' };
    const input: GenerateInput = {
      leadRequest: 'plumbing services miami',
      zips: ['33101'],
      scope: 'residential',
    };

    const lead = mapAudienceLabContactToLead(contact, input, 0);

    expect(lead.tags).toBe('plumbing services miami');
  });
});
