import { getDb } from '../db/client.js';
import {
  chargeAdditionalCredits,
  findUserCreditsById,
  refundCredits,
  reserveCredits as reserveCreditsRow,
  zeroCredits,
  type UserCreditsRow,
} from '../repositories/userCredits.js';
import { getClarityModel } from './chat-core.js';
import { log } from './logger.js';

/**
 * Credits Manager
 * Centralized utility for managing AI credits based on token usage
 * Supports tier-based credit multipliers for different Clarity models
 *
 * ## Where the guards live now
 *
 * Every balance check that used to be a Mongo `$expr` in the FILTER of a
 * `findOneAndUpdate` is now the `WHERE` clause of a Postgres `UPDATE`, inside
 * `repositories/userCredits.ts`. Nothing in this file compares a balance in
 * JavaScript and then writes: that shape is a read-modify-write race that
 * double-spends under load and passes every single-threaded test. A repository
 * function returning `null` IS the refusal — a driver failure still throws.
 */

export interface CreditUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  systemPromptTokens?: number; // Tokens from our system prompt (not charged to user)
}

export interface CreditReservation {
  userId: string;
  creditsReserved: number;
  initialFreeCredits: number;
  initialPaidCredits: number;
}

/**
 * Configuration for credit calculations
 */
export const CREDITS_CONFIG = {
  // How many tokens per 1 credit
  TOKENS_PER_CREDIT: 1000,

  // Minimum credits to charge per request
  MIN_CREDITS_PER_REQUEST: 1,

  // Initial credits to reserve (will be adjusted based on actual usage)
  INITIAL_RESERVATION: 1,
};

/**
 * Get credit multiplier for an Clarity model
 */
export async function getCreditMultiplier(clarityModelId?: string): Promise<number> {
  if (!clarityModelId) return 1;
  const model = await getClarityModel(clarityModelId);
  return model?.creditMultiplier || 1;
}

/**
 * Calculate credits needed based on token usage and model tier
 * Formula: Math.ceil((billableTokens / TOKENS_PER_CREDIT) * creditMultiplier)
 * Minimum: MIN_CREDITS_PER_REQUEST
 *
 * @param totalTokens - Total tokens reported by the provider
 * @param clarityModelId - The Clarity model being used
 * @param systemPromptTokens - Tokens from our system prompt (not charged to user)
 */
export async function calculateCreditsFromTokens(
  totalTokens: number,
  clarityModelId?: string,
  systemPromptTokens?: number
): Promise<number> {
  if (totalTokens === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  // Subtract system prompt tokens (our cost, not the user's)
  const systemTokens = systemPromptTokens || 0;
  const billableTokens = Math.max(0, totalTokens - systemTokens);

  log.credits.info({ totalTokens, systemTokens, billableTokens }, 'Token breakdown');

  const multiplier = await getCreditMultiplier(clarityModelId);
  const calculatedCredits = Math.ceil((billableTokens / CREDITS_CONFIG.TOKENS_PER_CREDIT) * multiplier);
  return Math.max(calculatedCredits, CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
}

/**
 * Reserve initial credits for a request
 * Returns null if insufficient credits
 */
export async function reserveCredits(
  userId: string,
  amount: number = CREDITS_CONFIG.INITIAL_RESERVATION
): Promise<CreditReservation | null> {
  try {
    // Free is spent first, then paid — the repository keeps that order, which is
    // deliberately the OPPOSITE of `deductCredits`. Both were found that way.
    const reserved = await reserveCreditsRow(getDb(), userId, amount);

    if (!reserved) {
      log.credits.info({ userId }, 'Insufficient credits for user');
      return null;
    }

    log.credits.info({ amount, userId }, 'Reserved credits for user');
    log.credits.info({ free: reserved.creditsFree, paid: reserved.creditsPaid }, 'Remaining credits');

    return {
      userId,
      creditsReserved: amount,
      initialFreeCredits: reserved.creditsFree,
      initialPaidCredits: reserved.creditsPaid,
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error reserving credits');
    throw error;
  }
}

/**
 * Shared credit adjustment logic used by both finalizeCredits and finalizeVoiceCredits.
 * Handles refund-if-over or charge-if-under relative to the initial reservation.
 */
async function _adjustReservation(
  reservation: CreditReservation,
  actualCreditsNeeded: number,
  label: string,
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  const db = getDb();
  const creditAdjustment = reservation.creditsReserved - actualCreditsNeeded;
  log.credits.info({ userId: reservation.userId, reserved: reservation.creditsReserved, actualNeeded: actualCreditsNeeded, creditAdjustment }, `Finalizing ${label}`);

  // The source read the row first and threw when it was absent, before deciding
  // whether any adjustment was due. Kept: a zero adjustment still has to report
  // the remaining balance, and a missing row is a different failure from a
  // refused write.
  let updatedCredits: UserCreditsRow | null = await findUserCreditsById(db, reservation.userId);

  if (!updatedCredits) {
    throw new Error('User credits not found');
  }

  if (creditAdjustment !== 0) {
    if (creditAdjustment > 0) {
      updatedCredits = await refundCredits(db, reservation.userId, creditAdjustment);
      log.credits.info({ refunded: creditAdjustment }, `Refunded ${label} credits`);
    } else {
      const additionalCredits = Math.abs(creditAdjustment);

      updatedCredits = await chargeAdditionalCredits(db, reservation.userId, additionalCredits);

      if (!updatedCredits) {
        // The overage cannot be covered. Both balances go to zero and the
        // shortfall is written off — a real policy, not an error path. The
        // request is NOT refused.
        updatedCredits = await zeroCredits(db, reservation.userId);
        log.credits.warn(`Insufficient credits for additional ${label} charge, set to 0`);
      } else {
        log.credits.info({ additionalCredits }, `Charged additional ${label} credits`);
      }
    }
  }

  if (!updatedCredits) {
    throw new Error('Failed to update credits');
  }

  const totalRemaining = updatedCredits.creditsFree + updatedCredits.creditsPaid;
  log.credits.info({ free: updatedCredits.creditsFree, paid: updatedCredits.creditsPaid, total: totalRemaining }, `Final ${label} credits`);

  return {
    creditsCharged: actualCreditsNeeded,
    creditsRemaining: totalRemaining,
  };
}

/**
 * Adjust credits based on actual token usage and model tier
 * If actual usage > reserved: deduct more
 * If actual usage < reserved: refund difference
 */
export async function finalizeCredits(
  reservation: CreditReservation,
  usage: CreditUsage,
  clarityModelId?: string
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    const actualCreditsNeeded = await calculateCreditsFromTokens(
      usage.totalTokens,
      clarityModelId,
      usage.systemPromptTokens
    );
    log.credits.info({ totalTokens: usage.totalTokens, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, systemTokens: usage.systemPromptTokens || 0 }, 'Token usage');
    return await _adjustReservation(reservation, actualCreditsNeeded, 'chat');
  } catch (error) {
    log.credits.error({ err: error }, 'Error finalizing credits');
    throw error;
  }
}

/**
 * Safely refund a credit reservation, swallowing errors.
 * Use this in error-handling paths where you must not throw.
 */
export async function safeRefund(
  reservation: CreditReservation | null,
  reason?: string
): Promise<void> {
  if (!reservation) return;
  await refundReservation(reservation);
  if (reason) {
    log.credits.info({ reason }, 'Refunded credits');
  }
}

/**
 * Refund all reserved credits (in case of error before streaming)
 *
 * The refund lands in `credits_free` even when the reservation was taken from
 * `credits_paid` — what `$inc: { 'credits.free': ... }` did. Preserved verbatim
 * because changing it moves real money between two buckets with different
 * top-up rules.
 */
export async function refundReservation(reservation: CreditReservation): Promise<void> {
  try {
    await refundCredits(getDb(), reservation.userId, reservation.creditsReserved);
    log.credits.info({ refunded: reservation.creditsReserved, userId: reservation.userId }, 'Refunded credits to user');
  } catch (error) {
    log.credits.error({ err: error }, 'Error refunding credits');
  }
}

/**
 * Get current credits for a user
 */
export async function getUserCredits(userId: string): Promise<{ free: number; paid: number; total: number } | null> {
  try {
    const row = await findUserCreditsById(getDb(), userId);
    if (!row) {
      return null;
    }

    return {
      free: row.creditsFree,
      paid: row.creditsPaid,
      total: row.creditsFree + row.creditsPaid,
    };
  } catch (error) {
    log.credits.error({ err: error }, 'Error getting user credits');
    return null;
  }
}

// ============== VOICE (TIME-BASED) BILLING ==============

/**
 * Calculate credits needed based on minutes and cost per minute
 * Used for voice/realtime API calls that are billed per minute
 *
 * @param minutes - Total minutes of voice call
 * @param clarityModelId - The Clarity model being used
 * @param costPerMinute - Provider's cost per minute (e.g., 0.05 for Grok)
 * @returns Credits to charge
 */
export async function calculateCreditsFromMinutes(
  minutes: number,
  clarityModelId: string,
  costPerMinute: number
): Promise<number> {
  if (minutes === 0) {
    return CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST;
  }

  const multiplier = await getCreditMultiplier(clarityModelId);

  // Convert to credits: $1 = 1000 credits
  // Example: $0.05/min * 1000 = 50 credits/min
  const baseCredits = Math.ceil(minutes * costPerMinute * 1000);
  const calculatedCredits = Math.ceil(baseCredits * multiplier);

  log.credits.info({ minutes: minutes.toFixed(2), costPerMinute, multiplier, calculatedCredits }, 'Voice credits calculated');

  return Math.max(calculatedCredits, CREDITS_CONFIG.MIN_CREDITS_PER_REQUEST);
}

/**
 * Reserve credits for a voice call (time-based)
 * Reserves credits for an estimated duration
 *
 * @param userId - User ID
 * @param estimatedMinutes - Estimated call duration in minutes
 * @param clarityModelId - The Clarity model being used
 * @param costPerMinute - Provider's cost per minute
 * @returns Credit reservation or null if insufficient
 */
export async function reserveVoiceCredits(
  userId: string,
  estimatedMinutes: number = 1,
  clarityModelId: string = 'clarity-v1',
  costPerMinute: number = 0.05
): Promise<CreditReservation | null> {
  const estimatedCredits = await calculateCreditsFromMinutes(
    estimatedMinutes,
    clarityModelId,
    costPerMinute
  );

  log.credits.info({ estimatedCredits, estimatedMinutes }, 'Reserving credits for voice call');

  return reserveCredits(userId, estimatedCredits);
}

/**
 * Finalize voice call credits based on actual duration
 * Adjusts the reservation based on actual time used
 *
 * @param reservation - The initial credit reservation
 * @param actualMinutes - Actual call duration in minutes
 * @param clarityModelId - The Clarity model used
 * @param costPerMinute - Provider's cost per minute
 * @returns Credits charged and remaining
 */
export async function finalizeVoiceCredits(
  reservation: CreditReservation,
  actualMinutes: number,
  clarityModelId: string,
  costPerMinute: number
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
  try {
    const actualCreditsNeeded = await calculateCreditsFromMinutes(
      actualMinutes,
      clarityModelId,
      costPerMinute
    );
    log.credits.info({ duration: actualMinutes.toFixed(2), costPerMinute }, 'Voice call duration');
    return await _adjustReservation(reservation, actualCreditsNeeded, 'voice');
  } catch (error) {
    log.credits.error({ err: error }, 'Error finalizing voice credits');
    throw error;
  }
}
