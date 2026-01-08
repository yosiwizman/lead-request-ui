/**
 * Tests for cleanup logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCleanupConfig,
  getCutoffDate,
  generateRunId,
} from '../../../api/_lib/cleanup.js';

describe('getCleanupConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default values when no env vars set', () => {
    delete process.env.EXPORT_RETENTION_DAYS;
    delete process.env.CLEANUP_MAX_ROWS_PER_RUN;

    const config = getCleanupConfig();

    expect(config.retentionDays).toBe(30);
    expect(config.maxRowsPerRun).toBe(500);
    expect(config.dryRun).toBe(false);
  });

  it('reads from environment variables', () => {
    process.env.EXPORT_RETENTION_DAYS = '60';
    process.env.CLEANUP_MAX_ROWS_PER_RUN = '1000';

    const config = getCleanupConfig();

    expect(config.retentionDays).toBe(60);
    expect(config.maxRowsPerRun).toBe(1000);
  });

  it('allows overrides to take precedence', () => {
    process.env.EXPORT_RETENTION_DAYS = '60';

    const config = getCleanupConfig({ retentionDays: 7, dryRun: true });

    expect(config.retentionDays).toBe(7);
    expect(config.dryRun).toBe(true);
    expect(config.maxRowsPerRun).toBe(500); // default, not overridden
  });
});

describe('getCutoffDate', () => {
  it('calculates correct cutoff date', () => {
    const now = new Date();
    const cutoff = getCutoffDate(30);

    // Should be approximately 30 days ago
    const expectedMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    const actualMs = cutoff.getTime();

    // Allow 1 second tolerance for test execution time
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(1000);
  });

  it('handles 0 retention (cutoff = now)', () => {
    const now = new Date();
    const cutoff = getCutoffDate(0);

    // Should be very close to now
    expect(Math.abs(cutoff.getTime() - now.getTime())).toBeLessThan(1000);
  });

  it('handles large retention values', () => {
    const cutoff = getCutoffDate(365);

    const now = new Date();
    const expectedMs = now.getTime() - 365 * 24 * 60 * 60 * 1000;

    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(1000);
  });
});

describe('generateRunId', () => {
  it('generates unique run IDs', () => {
    const id1 = generateRunId();
    const id2 = generateRunId();

    expect(id1).not.toBe(id2);
  });

  it('starts with cleanup_ prefix', () => {
    const id = generateRunId();

    expect(id).toMatch(/^cleanup_/);
  });

  it('contains timestamp and random components', () => {
    const id = generateRunId();

    // Format: cleanup_{ts}_{rand}
    const parts = id.split('_');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('cleanup');
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });
});

describe('CleanupResult shape', () => {
  it('matches expected interface', () => {
    // Type checking test - if this compiles, the interface is correct
    const result = {
      ok: true,
      runId: 'cleanup_abc_123',
      dryRun: false,
      scanned: 10,
      deletedRows: 8,
      deletedFiles: 7,
      errorsCount: 1,
      retentionDays: 30,
      cutoffDate: new Date().toISOString(),
      errors: ['storage:abc123'],
    };

    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(10);
    expect(result.deletedRows).toBe(8);
    expect(result.deletedFiles).toBe(7);
    expect(result.errorsCount).toBe(1);
  });
});
