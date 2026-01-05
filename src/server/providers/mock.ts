import type { Lead } from '../../types';
import type { GenerateInput } from './provider';

// Simple deterministic PRNG based on seed
function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeSeed(input: GenerateInput): number {
  const base = `${input.leadRequest}|${input.zips.join(',')}|${input.scope}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  }
  return hash;
}

const FIRST_NAMES = ['John', 'Jane', 'Mike', 'Sarah', 'David', 'Emily', 'Chris', 'Lisa', 'Tom', 'Anna'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Maple Dr', 'Cedar Ln', 'Elm St', 'Park Ave', 'Lake Rd'];
const CITIES = ['Miami', 'Tampa', 'Orlando', 'Jacksonville', 'Fort Lauderdale'];
const STATES = ['FL', 'GA', 'AL'];

function pick<T>(rand: () => number, arr: T[]) {
  return arr[Math.floor(rand() * arr.length)];
}

export function generateLeads(input: GenerateInput): Lead[] {
  const seed = makeSeed(input);
  const rand = seededRandom(seed);
  const count = 50;

  const out: Lead[] = [];
  for (let i = 0; i < count; i++) {
    const first = pick(rand, FIRST_NAMES);
    const last = pick(rand, LAST_NAMES);
    const leadType =
      input.scope === 'both' ? (rand() < 0.5 ? 'residential' : 'commercial') : input.scope;

    const zip = input.zips[Math.floor(rand() * input.zips.length)];

    out.push({
      first_name: first,
      last_name: last,
      address: `${Math.floor(rand() * 9999) + 1} ${pick(rand, STREETS)}`,
      city: pick(rand, CITIES),
      state: pick(rand, STATES),
      zip,
      phone: `(${Math.floor(rand() * 900) + 100}) ${Math.floor(rand() * 900) + 100}-${Math.floor(rand() * 9000) + 1000}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      lead_type: leadType,
      tags: input.leadRequest,
      source: 'lead-request-ui',
    });
  }
  return out;
}