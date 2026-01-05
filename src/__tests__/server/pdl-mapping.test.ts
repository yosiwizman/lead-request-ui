import { describe, it, expect } from 'vitest';
import { mapPDLPersonToLead } from '../../../api/_lib/providers/pdl';
import type { GenerateInput } from '../../../api/_lib/types';

describe('mapPDLPersonToLead', () => {
  const baseInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
  };

  it('maps full PDL person to Lead', () => {
    const testPhone = '555-123-4567';
    const person = {
      first_name: 'John',
      last_name: 'Doe',
      mobile_phone: testPhone,
      work_email: 'john.doe@company.com',
      personal_emails: ['john@personal.com'],
      location_street_address: '123 Main St',
      location_locality: 'Miami',
      location_region: 'FL',
      location_postal_code: '33101',
    };

    const lead = mapPDLPersonToLead(person, baseInput);

    expect(lead.first_name).toBe('John');
    expect(lead.last_name).toBe('Doe');
    expect(lead.phone).toBe(testPhone);
    expect(lead.email).toBe('john.doe@company.com');
    expect(lead.address).toBe('123 Main St');
    expect(lead.city).toBe('Miami');
    expect(lead.state).toBe('FL');
    expect(lead.zip).toBe('33101');
    expect(lead.lead_type).toBe('residential');
    expect(lead.tags).toBe('roofing');
    expect(lead.source).toBe('pdl');
  });

  it('falls back to personal email when work_email missing', () => {
    const person = {
      first_name: 'Jane',
      last_name: 'Smith',
      personal_emails: ['jane@gmail.com'],
    };

    const lead = mapPDLPersonToLead(person, baseInput);

    expect(lead.email).toBe('jane@gmail.com');
  });

  it('handles missing fields gracefully', () => {
    const person = {};

    const lead = mapPDLPersonToLead(person, baseInput);

    expect(lead.first_name).toBe('');
    expect(lead.last_name).toBe('');
    expect(lead.phone).toBe('');
    expect(lead.email).toBe('');
    expect(lead.address).toBe('');
    expect(lead.city).toBe('');
    expect(lead.state).toBe('');
    expect(lead.zip).toBe('');
    expect(lead.source).toBe('pdl');
  });

  it('uses scope from input for lead_type', () => {
    const commercialInput: GenerateInput = {
      leadRequest: 'solar',
      zips: ['90210'],
      scope: 'commercial',
    };

    const lead = mapPDLPersonToLead({ first_name: 'Test' }, commercialInput);

    expect(lead.lead_type).toBe('commercial');
  });

  it('defaults to residential when scope is both', () => {
    const bothInput: GenerateInput = {
      leadRequest: 'hvac',
      zips: ['12345'],
      scope: 'both',
    };

    const lead = mapPDLPersonToLead({ first_name: 'Test' }, bothInput);

    expect(lead.lead_type).toBe('residential');
  });
});
