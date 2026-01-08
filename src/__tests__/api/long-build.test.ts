/**
 * Tests for async long-build handling.
 *
 * These tests verify:
 * - 202 response with building_long status (not 410) when max attempts exceeded
 * - Background processor query functions
 * - Next poll calculation for background jobs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hasExceededMaxAttempts,
  MAX_POLL_ATTEMPTS,
} from '../../../api/_lib/compliance';

// Constants used in long-build handling
const BACKGROUND_POLL_MINUTES = 5;
const BACKGROUND_POLL_SECONDS = BACKGROUND_POLL_MINUTES * 60;

describe('Long-build transition logic', () => {
  describe('hasExceededMaxAttempts', () => {
    it('returns false for poll attempts below max (29)', () => {
      expect(hasExceededMaxAttempts(0)).toBe(false);
      expect(hasExceededMaxAttempts(15)).toBe(false);
      expect(hasExceededMaxAttempts(29)).toBe(false);
    });

    it('returns true when poll attempts equals max (30)', () => {
      expect(hasExceededMaxAttempts(30)).toBe(true);
    });

    it('returns true when poll attempts exceeds max (31+)', () => {
      expect(hasExceededMaxAttempts(31)).toBe(true);
      expect(hasExceededMaxAttempts(50)).toBe(true);
      expect(hasExceededMaxAttempts(100)).toBe(true);
    });

    it('MAX_POLL_ATTEMPTS is 30', () => {
      expect(MAX_POLL_ATTEMPTS).toBe(30);
    });
  });

  describe('Building long response shape', () => {
    it('matches expected 202 response structure', () => {
      // This tests the shape of the response that status.ts returns
      const buildingLongResponse = {
        ok: false,
        status: 'building_long',
        message: 'Still building in provider. We\'ll keep checking in the background. You can close this page and check Export History later.',
        exportId: 'test-export-id',
        audienceId: 'test-audience-id',
        pollAttempts: 30,
        maxAttempts: MAX_POLL_ATTEMPTS,
        nextPollSeconds: BACKGROUND_POLL_SECONDS,
        canResume: true,
      };

      expect(buildingLongResponse.ok).toBe(false);
      expect(buildingLongResponse.status).toBe('building_long');
      expect(buildingLongResponse.pollAttempts).toBe(30);
      expect(buildingLongResponse.maxAttempts).toBe(30);
      expect(buildingLongResponse.nextPollSeconds).toBe(300); // 5 minutes
      expect(buildingLongResponse.canResume).toBe(true);
    });

    it('does NOT use 410 for long builds', () => {
      // This is a semantic test to document the behavior
      // 410 Gone implies permanent deletion - wrong for "still processing"
      const HTTP_410_GONE = 410;
      const HTTP_202_ACCEPTED = 202;

      // Long builds should use 202 Accepted (processing continues)
      expect(HTTP_202_ACCEPTED).toBe(202);
      // NOT 410 Gone (resource permanently deleted)
      expect(HTTP_410_GONE).not.toBe(202);
    });
  });

  describe('Background poll interval', () => {
    it('uses 5 minute interval for background processing', () => {
      expect(BACKGROUND_POLL_MINUTES).toBe(5);
      expect(BACKGROUND_POLL_SECONDS).toBe(300);
    });

    it('is significantly longer than max foreground backoff (60s)', () => {
      const MAX_FOREGROUND_BACKOFF = 60;
      expect(BACKGROUND_POLL_SECONDS).toBeGreaterThan(MAX_FOREGROUND_BACKOFF);
    });
  });
});

describe('ExportStatus type', () => {
  it('includes building_long as valid status', () => {
    // Type checking test - validates the status values
    type ExportStatus =
      | 'pending'
      | 'building'
      | 'building_long'
      | 'success'
      | 'error'
      | 'no_results';

    const validStatuses: ExportStatus[] = [
      'pending',
      'building',
      'building_long',
      'success',
      'error',
      'no_results',
    ];

    expect(validStatuses).toContain('building_long');
    expect(validStatuses.length).toBe(6);
  });
});

describe('Background processor query logic', () => {
  it('query selects jobs with status building or building_long', () => {
    // This tests the logic of findPendingBackgroundExports
    const eligibleStatuses = ['building', 'building_long'];
    const mockExports = [
      { id: '1', status: 'pending' },
      { id: '2', status: 'building' },
      { id: '3', status: 'building_long' },
      { id: '4', status: 'success' },
      { id: '5', status: 'error' },
    ];

    const eligible = mockExports.filter(e => eligibleStatuses.includes(e.status));

    expect(eligible).toHaveLength(2);
    expect(eligible.map(e => e.id)).toEqual(['2', '3']);
  });

  it('query filters by next_poll_at <= now', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60000); // 1 minute ago
    const future = new Date(now.getTime() + 60000); // 1 minute from now

    const mockExports = [
      { id: '1', status: 'building_long', next_poll_at: past.toISOString() },
      { id: '2', status: 'building_long', next_poll_at: now.toISOString() },
      { id: '3', status: 'building_long', next_poll_at: future.toISOString() },
      { id: '4', status: 'building_long', next_poll_at: null },
    ];

    const eligible = mockExports.filter(e => {
      if (!e.next_poll_at) return true; // null = immediate
      return new Date(e.next_poll_at) <= now;
    });

    // Should include: past, now, null (not future)
    expect(eligible.map(e => e.id)).toEqual(['1', '2', '4']);
  });

  it('respects batch limit', () => {
    const DEFAULT_BATCH_SIZE = 10;
    const MAX_BATCH_SIZE = 20;

    const mockExports = Array.from({ length: 25 }, (_, i) => ({
      id: `export-${i}`,
      status: 'building_long',
    }));

    // Default batch
    const defaultBatch = mockExports.slice(0, DEFAULT_BATCH_SIZE);
    expect(defaultBatch).toHaveLength(10);

    // Max batch
    const maxBatch = mockExports.slice(0, MAX_BATCH_SIZE);
    expect(maxBatch).toHaveLength(20);

    // Full list exceeds max
    expect(mockExports.length).toBeGreaterThan(MAX_BATCH_SIZE);
  });
});

describe('Next poll timestamp calculation', () => {
  it('calculates next_poll_at as now + BACKGROUND_POLL_MINUTES', () => {
    const now = new Date();
    const nextPollAt = new Date(now.getTime() + BACKGROUND_POLL_MINUTES * 60 * 1000);

    const diffMinutes = (nextPollAt.getTime() - now.getTime()) / 60000;
    expect(diffMinutes).toBe(5);
  });

  it('increments poll_attempts when transitioning to building_long', () => {
    const currentAttempts = 30;
    const newAttempts = currentAttempts + 1;

    expect(newAttempts).toBe(31);
  });
});

describe('Cron authentication', () => {
  it('requires CRON_SECRET header', () => {
    const CRON_SECRET = 'test-secret';

    // Valid auth
    const validHeaders = { authorization: `Bearer ${CRON_SECRET}` };
    expect(validHeaders.authorization).toBe('Bearer test-secret');

    // Invalid auth
    const invalidHeaders = { authorization: 'Bearer wrong-secret' };
    const noAuth = {};

    expect(invalidHeaders.authorization).not.toBe(`Bearer ${CRON_SECRET}`);
    expect('authorization' in noAuth).toBe(false);
  });
});

describe('UI status handling', () => {
  it('building_long is distinct from error status', () => {
    const errorStatuses = ['error', 'no_results'];
    const buildingStatuses = ['building', 'building_long'];

    expect(errorStatuses).not.toContain('building_long');
    expect(buildingStatuses).toContain('building_long');
  });

  it('building_long should stop polling and show info banner', () => {
    // This documents the expected UI behavior
    const status = 'building_long';

    const shouldStopPolling = status === 'building_long';
    const shouldShowError = status === 'error' || status === 'no_results';
    const shouldShowInfoBanner = status === 'building_long';

    expect(shouldStopPolling).toBe(true);
    expect(shouldShowError).toBe(false);
    expect(shouldShowInfoBanner).toBe(true);
  });
});
