/**
 * Gateway Client (local-only)
 *
 * Gateway service is removed. This module is now a thin wrapper around the
 * local providers implementation so existing imports keep working.
 */

import { getDb } from '../db/client.js';
import { listPackages } from '../repositories/credit-packages.js';
import { listFeatures } from '../repositories/features.js';
import { listMappings } from '../repositories/plan-features.js';
import { listPlans, patchPlan } from '../repositories/plans.js';
import { log } from './logger.js';
import { getStatusCode } from './errors/index.js';

// ============== MODE DETECTION ==============


// Gateway HTTP helpers removed (gateway service deprecated)

// ============== TYPES ==============

export interface KeyConfig {
  keyId?: string;
  provider: string;
  modelId: string;
  key: string;
  isPaid?: boolean;
  rps?: number;
  rpm?: number;
  rph?: number;
  rpd?: number;
  tps?: number;
  tpm?: number;
  tph?: number;
  tpd?: number;
}

export interface ClarityModel {
  id: string;
  name: string;
  tier: string;
  description: string;
  creditMultiplier: number;
  maxTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  category: string;
  emoji?: string;
  chatVisible?: boolean;
}

export interface ModelMapping {
  provider: string;
  modelId: string;
  priority: number;
  qualityScore: number;
  pricingTier: string;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  costPerMinute?: number;
  averageLatencyMs?: number;
  capabilities: Record<string, unknown>;
}

export interface ResolvedModel {
  clarityModelId: string;
  provider: string;
  modelId: string;
  keyConfig: KeyConfig;
  clarityModel: ClarityModel;
  isFallback: boolean;
}

export interface HealthMetrics {
  provider: string;
  modelId: string;
  successCount: number;
  failureCount: number;
  totalRequests: number;
  successRate: number;
  averageLatencyMs: number;
  lastSuccess: Date | null;
  lastFailure: Date | null;
  consecutiveFailures: number;
  circuitState: string;
  lastHealthCheck: Date;
  isHealthy: boolean;
}

export interface ClarityModelWithAvailability extends ClarityModel {
  isAvailable: boolean;
  isLegacy: boolean;
}

export type ClarityTier = string;
export type ModelCategory = string;
export type PricingTier = string;

// Plain (non-Document) interfaces for billing data returned by API or .lean()
export interface PlanData {
  planId: string;
  name: string;
  product: 'clarity' | 'codea';
  creditsPerMonth: number;
  dailyFreeCredits: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  modelIds: string[];
  isActive: boolean;
  isFree: boolean;
  stripeProductId?: string;
  stripeMonthlyPriceId?: string;
  stripeAnnualPriceId?: string;
  description?: string;
}

export interface CreditPackageData {
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  stripePriceId?: string;
  sortOrder: number;
  isActive: boolean;
  description?: string;
}

export interface FeatureData {
  featureId: string;
  label: string;
  description?: string;
  icon?: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
  isActive: boolean;
}

export interface PlanFeatureData {
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number;
  displayLabel?: string;
  displayDescription?: string;
}

// ============== IN-MEMORY CACHE (HTTP mode only) ==============

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL = 60_000; // 60 seconds
let modelsCache: CacheEntry<ClarityModel[]> | null = null;

function isCacheValid<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && Date.now() < entry.expiresAt;
}

// ============== MODEL RESOLUTION ==============

/**
 * Resolve a Clarity model to a concrete provider + key.
 * Used before streaming chat completions.
 */
export async function resolveClarityModel(
  model: string,
  tokens: number = 1000,
  skipProviders: Set<string> = new Set(),
  skipKeyIds?: Set<string>
): Promise<ResolvedModel | null> {

  // Local fallback
  const { resolveClarityModel: localResolve } = await import('../internal/providers/lib/model-resolver.js');
  return localResolve(model, tokens, skipProviders, skipKeyIds || new Set());
}

// ============== PROVIDER HELPERS ==============

/** DO async-invoke models (fal-ai) need longer timeouts for queue + cold start + execution */
export function getProviderTimeout(modelId: string): number {
  return modelId.startsWith('fal-ai/') ? 120_000 : 15_000;
}

// ============== PROVIDER API CALLS ==============

export interface ProviderCallOptions {
  provider: string;
  modelId: string;
  endpoint: string;
  body?: Record<string, unknown>;
  audio?: { base64: string; mimeType: string; filename: string };
  extraFormFields?: Record<string, string>;
  maxAttempts?: number;
  timeout?: number;
  responseType?: 'json' | 'arrayBuffer';
  signal?: AbortSignal;
}

/**
 * Non-streaming provider API call with key rotation and retries.
 * Used for images, embeddings, transcription.
 */
export async function callProviderAPI<T = unknown>(options: ProviderCallOptions): Promise<T> {

  // Local fallback — convert audio field to FormData for the local callProviderAPI
  const { callProviderAPI: localCall } = await import('../internal/providers/lib/provider-api.js');

  let formData: FormData | undefined;
  if (options.audio?.base64) {
    const buffer = Buffer.from(options.audio.base64, 'base64');
    const blob = new Blob([buffer], { type: options.audio.mimeType || 'audio/webm' });
    formData = new FormData();
    formData.append('file', blob, options.audio.filename || 'audio.webm');
    if (options.extraFormFields) {
      for (const [key, value] of Object.entries(options.extraFormFields)) {
        formData.append(key, value);
      }
    }
  }

  return localCall<T>({
    provider: options.provider,
    modelId: options.modelId,
    endpoint: options.endpoint,
    body: options.body,
    formData,
    maxAttempts: options.maxAttempts,
    timeout: options.timeout,
    responseType: options.responseType,
    signal: options.signal,
  });
}

// ============== USAGE REPORTING ==============

/**
 * Report model usage after streaming (fire-and-forget).
 */
export function reportModelUsage(
  keyId: string,
  provider: string,
  modelId: string,
  success: boolean,
  opts?: { latencyMs?: number; errorCode?: string; tokens?: number; reason?: string; retryAfterMs?: number }
): void {

  // Local fallback — fire-and-forget
  (async () => {
    try {
      const { recordKeySuccess, recordKeyFailure } = await import('../internal/providers/lib/key-manager.js');
      const { recordSuccess, recordFailure } = await import('../internal/providers/lib/provider-health.js');

      if (success) {
        await recordKeySuccess(keyId);
        await recordSuccess(provider, modelId, opts?.latencyMs ?? 0);
      } else {
        await recordKeyFailure(keyId, opts?.errorCode || 'unknown', opts?.retryAfterMs);
        await recordFailure(provider, modelId, opts?.errorCode || 'unknown');
      }
    } catch (err) {
      log.general.warn({ err }, 'Failed to report model usage (local)');
    }
  })();
}

// ============== MODEL DATA ==============

/**
 * Get all Clarity models.
 */
export async function getAllClarityModels(): Promise<ClarityModel[]> {

  const { getAllClarityModels: localGetAll } = await import('../internal/providers/lib/clarity-models.js');
  return localGetAll();
}

/**
 * Get all Clarity models with availability (checks health).
 */
export async function getAvailableModels(): Promise<ClarityModelWithAvailability[]> {

  const { getAvailableModels: localGetAvailable } = await import('../internal/providers/lib/clarity-models.js');
  return localGetAvailable();
}

/**
 * Get a specific Clarity model by ID.
 */
export async function getClarityModel(modelId: string): Promise<ClarityModel | null> {

  const { getClarityModel: localGet } = await import('../internal/providers/lib/clarity-models.js');
  return localGet(modelId);
}

/**
 * Synchronous model lookup from cache (returns null if cache cold).
 */
export function getClarityModelSync(modelId: string): ClarityModel | null {

  // Local: always available from static CLARITY_MODELS
  // Use synchronous require-like approach via dynamic import cache
  // Since this is sync, we can't use await — fall back to null if not cached
  try {
    // The module is likely already loaded from a prior async call
    const mod = (globalThis as unknown as Record<string, { getClarityModel: (id: string) => ClarityModel | null }>).__clarityModelsCache;
    if (mod) return mod.getClarityModel(modelId);
  } catch { /* ignore */ }
  return null;
}

/**
 * Check if a model ID is a Clarity model.
 */
export async function isClarityModel(modelId: string): Promise<boolean> {

  const { isClarityModel: localIsClarity } = await import('../internal/providers/lib/clarity-models.js');
  return localIsClarity(modelId);
}

/**
 * Get all Clarity models by category.
 */
export async function getClarityModelsByCategory(category: string): Promise<ClarityModel[]> {

  const { getClarityModelsByCategory: localGetByCategory } = await import('../internal/providers/lib/clarity-models.js');
  return localGetByCategory(category as never);
}

/**
 * Get default model for a category.
 */
export async function getDefaultModelForCategory(category: string): Promise<ClarityModel | null> {

  const { getDefaultModelForCategory: localGetDefault } = await import('../internal/providers/lib/clarity-models.js');
  return localGetDefault(category as never);
}

/**
 * Get the default Clarity model ID.
 */
export function getDefaultClarityModel(): string {
  return 'clarity-fast';
}

// ============== TIER MAPPINGS ==============

/**
 * Get tier-to-model mappings.
 */
export async function getTierMappings(): Promise<Record<string, ModelMapping[]>> {
  const { TIER_MODEL_MAPPINGS } = await import('../internal/providers/lib/clarity-models.js');
  return TIER_MODEL_MAPPINGS as unknown as Record<string, ModelMapping[]>;
}

/**
 * Get model mappings for a specific tier.
 */
export async function getModelMappingsForTier(tier: string): Promise<ModelMapping[]> {
  const { getModelMappingsForTier: localGetMappings } = await import('../internal/providers/lib/clarity-models.js');
  return localGetMappings(tier as never) as unknown as ModelMapping[];
}

// ============== PROVIDER HEALTH ==============

/**
 * Get all provider health metrics.
 */
export async function getAllProviderHealth(): Promise<HealthMetrics[]> {
  const { getAllProviderHealth: localGetAll } = await import('../internal/providers/lib/provider-health.js');
  return localGetAll();
}

/**
 * Get health for a specific provider/model.
 */
export async function getProviderHealth(provider: string, modelId: string): Promise<HealthMetrics> {
  const { getProviderHealth: localGet } = await import('../internal/providers/lib/provider-health.js');
  return localGet(provider, modelId);
}

// ============== BILLING DATA ==============

/**
 * Get plans.
 */
export async function getPlans(filter?: Parameters<typeof listPlans>[1]): Promise<PlanData[]> {
  return (await listPlans(getDb(), filter ?? {})) as unknown as PlanData[];
}

/**
 * Get credit packages.
 */
export async function getCreditPackages(active?: boolean): Promise<CreditPackageData[]> {
  // Built from DEFINED keys only: `{ isActive: undefined }` is a no-op filter in
  // Mongo and would be a real `where isActive is null` if passed through here.
  return (await listPackages(getDb(), active === undefined ? {} : { isActive: active })) as unknown as CreditPackageData[];
}

/**
 * Get features.
 */
export async function getFeatures(): Promise<FeatureData[]> {
  return (await listFeatures(getDb())) as unknown as FeatureData[];
}

/**
 * Get plan features.
 */
export async function getPlanFeatures(planId?: string): Promise<PlanFeatureData[]> {
  return (await listMappings(getDb(), planId ? { planId } : {})) as unknown as PlanFeatureData[];
}

/**
 * Update a plan (e.g. to persist auto-created Stripe price IDs).
 */
export async function updatePlan(
  planId: string,
  updates: Parameters<typeof patchPlan>[2],
): Promise<PlanData | null> {
  return (await patchPlan(getDb(), planId, updates)) as unknown as PlanData | null;
}

// ============== KEY MANAGEMENT ==============

/**
 * Mark a provider key as credit-exhausted.
 * Routes through gateway API when enabled so it operates on the correct database.
 */
export async function markKeyCreditExhausted(keyId: string): Promise<void> {
  if (!keyId) return;
  const { markKeyCreditExhausted: localMark } = await import('../internal/providers/lib/key-manager.js');
  localMark(keyId).catch(() => {});
}

// ============== CACHE WARMUP ==============

/**
 * Warm up the in-memory cache at startup.
 */
export async function warmupGatewayClient(): Promise<void> {
  log.general.info('Gateway client using local modules — no warmup needed');
}
