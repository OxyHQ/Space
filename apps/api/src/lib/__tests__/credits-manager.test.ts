import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserCreditsRow } from '../../repositories/userCredits.js';

/**
 * These mocks stand in for `repositories/userCredits.ts`, not for a driver.
 *
 * The point of that boundary is what this file can no longer assert: the old
 * version checked that `refundReservation` called `findByIdAndUpdate` with
 * `{ $inc: { 'credits.free': 5 } }` — an assertion about a Mongo statement,
 * re-stated in the test. The compare-and-set semantics now live in SQL and are
 * covered against a REAL server by `repositories/__tests__/userCredits.pgdb.test.ts`,
 * where a guard that stops guarding actually fails. What is left here is this
 * module's own logic: the arithmetic, the branch selection, and which repository
 * call each branch makes.
 */
const mockRepository = vi.hoisted(() => ({
  findUserCreditsById: vi.fn(),
  reserveCredits: vi.fn(),
  chargeAdditionalCredits: vi.fn(),
  zeroCredits: vi.fn(),
  refundCredits: vi.fn(),
}));

vi.mock('../../repositories/userCredits.js', () => mockRepository);

vi.mock('../../db/client.js', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('../chat-core.js', () => ({
  getClarityModel: vi.fn().mockResolvedValue({ creditMultiplier: 1 }),
}));

vi.mock('../logger.js', () => ({
  log: {
    credits: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import {
  reserveCredits,
  finalizeCredits,
  finalizeVoiceCredits,
  refundReservation,
  safeRefund,
  calculateCreditsFromTokens,
  calculateCreditsFromMinutes,
  getUserCredits,
  CREDITS_CONFIG,
  type CreditReservation,
} from '../credits-manager.js';

/**
 * A complete row, not a partial cast. The whole reason this module was
 * dangerous to port is that a missing field reads `undefined` and `undefined || 0`
 * yields 0 — a fixture that omits columns reproduces the bug rather than
 * catching it.
 */
function makeCreditsRow(free: number, paid: number): UserCreditsRow {
  return {
    id: 'user-1',
    creditsFree: free,
    creditsFreeLimit: 300,
    creditsDailyRefresh: 300,
    creditsPaid: paid,
    creditsLastRefresh: new Date('2026-08-12T00:00:00Z'),
    creditsLastUsed: null,
    stripeCustomerId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-12T00:00:00Z'),
  };
}

describe('credits-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateCreditsFromTokens', () => {
    it('returns minimum credits for 0 tokens', async () => {
      expect(await calculateCreditsFromTokens(0)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
    });

    it('calculates credits from token count', async () => {
      // 5000 tokens / 1000 tokens per credit = 5 credits
      expect(await calculateCreditsFromTokens(5000)).toBe(5);
    });

    it('rounds up partial credits', async () => {
      // 1500 tokens / 1000 = 1.5 → ceil = 2
      expect(await calculateCreditsFromTokens(1500)).toBe(2);
    });

    it('subtracts system prompt tokens', async () => {
      // 5000 total - 3000 system = 2000 billable / 1000 = 2
      expect(await calculateCreditsFromTokens(5000, undefined, 3000)).toBe(2);
    });

    it('floors billable tokens at 0 when system > total', async () => {
      // 1000 total - 5000 system = max(0, -4000) = 0 → min 1
      expect(await calculateCreditsFromTokens(1000, undefined, 5000)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
    });

    it('enforces minimum credits', async () => {
      // 1 token → 0.001 → ceil = 1 → max(1, 1) = 1
      expect(await calculateCreditsFromTokens(1)).toBe(1);
    });
  });

  describe('calculateCreditsFromMinutes', () => {
    it('returns minimum credits for 0 minutes', async () => {
      expect(await calculateCreditsFromMinutes(0, 'clarity-v1', 0.05)).toBe(CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
    });

    it('calculates credits from minutes', async () => {
      // 2 min * $0.05/min * 1000 = 100 credits
      expect(await calculateCreditsFromMinutes(2, 'clarity-v1', 0.05)).toBe(100);
    });

    it('rounds up partial credits', async () => {
      // 0.5 min * $0.05/min * 1000 = 25 credits
      expect(await calculateCreditsFromMinutes(0.5, 'clarity-v1', 0.05)).toBe(25);
    });
  });

  describe('reserveCredits', () => {
    it('reserves credits successfully', async () => {
      mockRepository.reserveCredits.mockResolvedValue(makeCreditsRow(9, 10));

      const result = await reserveCredits('user-1', 1);

      expect(result).toEqual({
        userId: 'user-1',
        creditsReserved: 1,
        initialFreeCredits: 9,
        initialPaidCredits: 10,
      });
    });

    it('returns null for insufficient credits', async () => {
      // An empty result IS the refusal: the balance guard is the UPDATE's own
      // WHERE clause, so "no row matched" and "cannot afford it" are one answer.
      mockRepository.reserveCredits.mockResolvedValue(null);

      const result = await reserveCredits('user-1', 100);
      expect(result).toBeNull();
    });

    it('throws on database error', async () => {
      // The other half of that: a driver failure is NOT a refusal and must not
      // be reported as one.
      mockRepository.reserveCredits.mockRejectedValue(new Error('DB error'));

      await expect(reserveCredits('user-1', 1)).rejects.toThrow('DB error');
    });
  });

  describe('finalizeCredits', () => {
    const reservation: CreditReservation = {
      userId: 'user-1',
      creditsReserved: 5,
      initialFreeCredits: 10,
      initialPaidCredits: 10,
    };

    it('refunds excess when actual < reserved', async () => {
      // reserved 5, actual 2 → refund 3
      mockRepository.findUserCreditsById.mockResolvedValue(makeCreditsRow(5, 10));
      mockRepository.refundCredits.mockResolvedValue(makeCreditsRow(8, 10));

      const result = await finalizeCredits(reservation, {
        promptTokens: 1000,
        completionTokens: 1000,
        totalTokens: 2000,
        systemPromptTokens: 0,
      });

      expect(result.creditsCharged).toBe(2);
      expect(result.creditsRemaining).toBe(18);
      expect(mockRepository.refundCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 3);
      expect(mockRepository.chargeAdditionalCredits).not.toHaveBeenCalled();
    });

    it('charges more when actual > reserved', async () => {
      // reserved 5, actual 10 → charge 5 more
      mockRepository.findUserCreditsById.mockResolvedValue(makeCreditsRow(5, 10));
      mockRepository.chargeAdditionalCredits.mockResolvedValue(makeCreditsRow(0, 10));

      const result = await finalizeCredits(reservation, {
        promptTokens: 5000,
        completionTokens: 5000,
        totalTokens: 10000,
        systemPromptTokens: 0,
      });

      expect(result.creditsCharged).toBe(10);
      expect(result.creditsRemaining).toBe(10);
      expect(mockRepository.chargeAdditionalCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 5);
      expect(mockRepository.zeroCredits).not.toHaveBeenCalled();
    });

    it('sets credits to 0 when insufficient for additional charge', async () => {
      // The write-off branch. This is a POLICY — the overage is absorbed and the
      // request is not refused — so it must not be tidied into a rejection.
      mockRepository.findUserCreditsById.mockResolvedValue(makeCreditsRow(0, 2));
      mockRepository.chargeAdditionalCredits.mockResolvedValue(null);
      mockRepository.zeroCredits.mockResolvedValue(makeCreditsRow(0, 0));

      const result = await finalizeCredits(reservation, {
        promptTokens: 50000,
        completionTokens: 50000,
        totalTokens: 100000,
        systemPromptTokens: 0,
      });

      expect(result.creditsCharged).toBe(100);
      expect(result.creditsRemaining).toBe(0);
      expect(mockRepository.zeroCredits).toHaveBeenCalledWith(expect.anything(), 'user-1');
    });

    it('makes no adjustment call when actual equals reserved', async () => {
      // reserved 5, 5000 tokens → actual 5 → adjustment 0.
      mockRepository.findUserCreditsById.mockResolvedValue(makeCreditsRow(5, 10));

      const result = await finalizeCredits(reservation, {
        promptTokens: 2500,
        completionTokens: 2500,
        totalTokens: 5000,
        systemPromptTokens: 0,
      });

      expect(result.creditsCharged).toBe(5);
      expect(result.creditsRemaining).toBe(15);
      expect(mockRepository.refundCredits).not.toHaveBeenCalled();
      expect(mockRepository.chargeAdditionalCredits).not.toHaveBeenCalled();
      expect(mockRepository.zeroCredits).not.toHaveBeenCalled();
    });

    it('throws when user not found', async () => {
      mockRepository.findUserCreditsById.mockResolvedValue(null);

      await expect(
        finalizeCredits(reservation, {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 1000,
          systemPromptTokens: 0,
        })
      ).rejects.toThrow('User credits not found');
    });
  });

  describe('finalizeVoiceCredits', () => {
    const reservation: CreditReservation = {
      userId: 'user-1',
      creditsReserved: 100,
      initialFreeCredits: 500,
      initialPaidCredits: 500,
    };

    it('refunds excess when actual < reserved', async () => {
      // reserved 100, actual: 0.5 min * $0.05/min * 1000 = 25
      mockRepository.findUserCreditsById.mockResolvedValue(makeCreditsRow(400, 500));
      mockRepository.refundCredits.mockResolvedValue(makeCreditsRow(475, 500));

      const result = await finalizeVoiceCredits(reservation, 0.5, 'clarity-v1', 0.05);

      expect(result.creditsCharged).toBe(25);
      expect(result.creditsRemaining).toBe(975);
      expect(mockRepository.refundCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 75);
    });
  });

  describe('refundReservation', () => {
    it('refunds all reserved credits', async () => {
      mockRepository.refundCredits.mockResolvedValue(makeCreditsRow(15, 10));

      await refundReservation({
        userId: 'user-1',
        creditsReserved: 5,
        initialFreeCredits: 10,
        initialPaidCredits: 10,
      });

      // Refunds land in `credits_free` even when the reservation came out of
      // `credits_paid` — what `$inc: { 'credits.free': ... }` did. Asserted so
      // the choice cannot be reversed silently.
      expect(mockRepository.refundCredits).toHaveBeenCalledWith(expect.anything(), 'user-1', 5);
    });

    it('does not throw on database error (logs instead)', async () => {
      mockRepository.refundCredits.mockRejectedValue(new Error('DB error'));

      // Should not throw
      await refundReservation({
        userId: 'user-1',
        creditsReserved: 5,
        initialFreeCredits: 10,
        initialPaidCredits: 10,
      });
    });
  });

  describe('safeRefund', () => {
    it('does nothing for null reservation', async () => {
      await safeRefund(null);
      expect(mockRepository.refundCredits).not.toHaveBeenCalled();
    });

    it('refunds valid reservation', async () => {
      mockRepository.refundCredits.mockResolvedValue(makeCreditsRow(15, 10));

      await safeRefund({
        userId: 'user-1',
        creditsReserved: 5,
        initialFreeCredits: 10,
        initialPaidCredits: 10,
      }, 'test reason');

      expect(mockRepository.refundCredits).toHaveBeenCalled();
    });
  });

  describe('getUserCredits', () => {
    it('returns credits for existing user', async () => {
      mockRepository.findUserCreditsById.mockResolvedValue(makeCreditsRow(10, 20));

      const result = await getUserCredits('user-1');
      expect(result).toEqual({ free: 10, paid: 20, total: 30 });
    });

    it('returns null for non-existent user', async () => {
      mockRepository.findUserCreditsById.mockResolvedValue(null);

      const result = await getUserCredits('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null on database error', async () => {
      mockRepository.findUserCreditsById.mockRejectedValue(new Error('DB error'));

      const result = await getUserCredits('user-1');
      expect(result).toBeNull();
    });
  });
});
