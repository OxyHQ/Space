import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { PROVIDER_NAMES } from '../../internal/providers/lib/provider-names.js';

/**
 * The internal AI provider-routing layer, ported from Mongo.
 *
 * Conventions come from `workspaces.ts` — read it first. What follows is only
 * what this domain decides on top of them.
 *
 * ## Numbers
 *
 * Mongo stores every `Number` as a double, and several of these fields are
 * written straight from `req.body` by admin routes that do no type narrowing
 * (`ModelConfig.create(modelData)` at `internal/providers/routes/models.ts:134`
 * is the clearest case). So a Mongoose `Number` becomes:
 *
 *  - `bigint({ mode: 'number' })` for a LIFETIME COUNTER — something only ever
 *    `$inc`-ed by whole numbers and able to outgrow `int4`.
 *  - `integer` for a BOUNDED counter that resets (`consecutiveFailures`).
 *  - `doublePrecision` for everything else, INCLUDING fields that look integral
 *    (`priority`, `sortOrder`, `qualityScore`). Narrowing those to `integer`
 *    would reject a fractional value that Mongo accepts today, on a path a
 *    client can reach — a behaviour change wearing the clothes of a tidy-up.
 *
 * Money (`spentUSD`, `costUSD`, `monthlyPrice`, …) stays `doublePrecision`
 * rather than becoming `numeric`. `numeric` is the better type for currency and
 * this is not the change that should introduce it: it would alter the
 * arithmetic behind `spentUSD >= creditLimitUSD`, and postgres.js decodes
 * `numeric` as a STRING while drizzle types it `number`, so every comparison
 * would need a coercion the source never had.
 *
 * ## Slugs with a Mongoose `lowercase: true` setter
 *
 * `clarityModelId`, `planId`, `featureId` and `packageId` all carry one. The
 * setter runs on WRITES *and on QUERY VALUES*, so `findOne({ planId: 'Pro' })`
 * matches the stored `'pro'` today, and it exists to uphold that field's unique
 * index. Each ports as a plain `unique()` PLUS a CHECK that the stored value
 * equals its own `lower()`.
 *
 * Not a functional unique index on `lower(...)`, which was the first design and
 * is worse in two ways. A functional index cannot be an `ON CONFLICT` target
 * and cannot be a foreign-key target, so every upsert in this domain would have
 * had to fall back to a bare `ON CONFLICT DO NOTHING` that fires on ANY unique
 * — silently broadening the moment a table gains a second one. And it makes
 * case-insensitivity a property of the INDEX rather than of the DATA, so a
 * mixed-case row is storable and simply invisible to a `lower()` lookup.
 *
 * With the CHECK, a writer that forgets to normalise gets a loud constraint
 * violation instead of a silently unfindable row, and the repositories'
 * `lower(col) = lower($1)` lookups keep the query half of the setter.
 *
 * ## Sub-document arrays
 *
 * Two of them become child tables (`clarity_model_provider_mappings`,
 * `fallback_event_attempts`) because both are read relationally — filtered,
 * sorted and `$unwind`-ed. `provider_healths.latencySamples` deliberately does
 * NOT: it is a bounded ring buffer of the last 100 latencies, never queried,
 * only reduced to an average, and a child table would turn one row update into
 * a hundred.
 *
 * ## Provider names
 *
 * `PROVIDER_NAMES` is imported rather than re-spelled so the CHECK cannot drift
 * from the enum the Mongoose schemas use. Nothing in this file may reach a
 * user-facing response: the names live in CHECK constraints and in columns
 * (`cost_entries.actualProvider`, `provider_healths.provider`) that are
 * internal-only, and any error path that quotes one goes through
 * `sanitizeMessage()` from `src/lib/errors/sanitize.ts`.
 */

export const KEY_ENVIRONMENTS = ['production', 'staging', 'development'] as const;
export const KEY_TIERS = ['free', 'freemium', 'paid', 'enterprise'] as const;
export const KEY_ROTATION_SCHEDULES = ['manual', 'monthly', 'quarterly', 'yearly'] as const;
export const PRICING_TIERS = ['free', 'freemium', 'paid'] as const;
export const CIRCUIT_STATES = ['closed', 'open', 'half-open'] as const;
export const PLAN_PRODUCTS = ['clarity', 'codea'] as const;
export const FEATURE_TYPES = ['boolean', 'limit'] as const;

/**
 * Clarity tiers. Declared once and used by both `clarity_models.tier` and
 * `model_configs.clarityTier`, which spell the same 13 values independently in
 * Mongo (`clarity-model.ts:115` and `model-config.ts:96`) and would otherwise
 * drift apart the first time one gains a value.
 */
export const CLARITY_TIERS = [
  'lite',
  'v1',
  'v1-codea',
  'v1-cowork',
  'v1-browser',
  'v1-vision',
  'v1-audio',
  'v1-tts',
  'v1-multimodal',
  'v1-pro',
  'v1-pro-max',
  'v1-voice',
  'v1-voice-pro',
] as const;

export type KeyEnvironment = (typeof KEY_ENVIRONMENTS)[number];
export type KeyTier = (typeof KEY_TIERS)[number];
export type CircuitState = (typeof CIRCUIT_STATES)[number];
export type PlanProduct = (typeof PLAN_PRODUCTS)[number];
export type FeatureType = (typeof FEATURE_TYPES)[number];
export type ClarityTier = (typeof CLARITY_TIERS)[number];

/**
 * The Mongo TTL retentions this domain carried, in seconds. Declared beside the
 * tables they belong to so `db/expiry-targets.ts` cannot drift from the schema,
 * and asserted against the source models by `providerExpiry.pgdb.test.ts`.
 */
export const FALLBACK_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_HEALTH_METRIC_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** `maxlength`s that genuinely fire — see the note on `providerKeys.name`. */
export const KEY_NAME_MAX = 200;
export const KEY_PREFIX_MAX = 20;
export const FAILURE_REASON_MAX = 500;
export const DESCRIPTION_MAX = 1000;
export const NOTES_MAX = 2000;
export const PROVIDER_URL_MAX = 500;

/**
 * Provider API keys — the highest-risk table in this domain.
 *
 * ## `keyHash` is matched on, `key` is only ever read
 *
 * That asymmetry decides the storage of both, and getting it backwards is the
 * expensive mistake: a randomised-IV scheme over `keyHash` would make
 * `findByKeyHash` match nothing, and the symptom is not an error — it is
 * `POST /v1/keys` cheerfully accepting a key that already exists, and
 * `validateKey` rejecting the correct key.
 *
 *  - `keyHash` is `sha256(key)` hex (`provider-key.ts:213`, `routes/keys.ts:265`
 *    and `:444` all compute it the same way). It is the deduplication lookup
 *    AND the unique. It must stay a DETERMINISTIC digest — never encrypted,
 *    never salted per-row.
 *  - `key` is the secret itself. It is written, and read once per request to be
 *    handed to the provider (`key-manager.ts:282`). Nothing anywhere matches,
 *    sorts or groups on it — verified by grepping every filter against this
 *    model.
 *
 * The source Mongoose schema declares NO field-level `get`/`set` and no
 * `toJSON: { getters: true }`, so a Mongoose read and a raw-driver read return
 * the same bytes: whatever the writer stored, in the clear. This port copies
 * that verbatim, which is what makes a backfill a straight copy. Encrypting
 * `key` at rest is a real improvement and a SEPARATE change — it is a new
 * invariant, not an existing one made structural, and doing it here would give
 * the backfill a failure mode ("copied plaintext into the column everyone
 * believes is ciphertext") that looks exactly like success.
 *
 * The asymmetry is defended by `__tests__/provider-keys.pgdb.test.ts`, which
 * fails if `keyHash` stops being deterministic and fails if a lookup by the
 * secret value is ever introduced.
 */
export const providerKeys = pgTable(
  'provider_keys',
  {
    id: generatedId(),
    /**
     * `maxlength: 200` fires: keys are written by `ProviderKey.create(...)`
     * (`routes/keys.ts:281`), by `key.save()` (`:462`, and both document
     * methods on the model), and by `findByIdAndUpdate(..., { runValidators:
     * true })` (`:346`) — all three run validators. So it becomes a live CHECK
     * rather than being dropped as a validator that never ran.
     */
    name: text().notNull(),
    provider: text().notNull(),
    environment: text().notNull().default('production'),
    /** sha256 hex of `key`. Deterministic by contract — see the table note. */
    keyHash: text().notNull(),
    /** First 8 characters plus `...`, for display. Derived, never matched on. */
    keyPrefix: text().notNull(),
    /** The secret. Nullable: `key-manager.ts:272` skips a key that has none. */
    key: text(),

    /**
     * `rateLimit` flattened. The sub-document has no `required` and no default
     * on any member, so every column is nullable and "unset" means "no limit of
     * this kind" — which is what `key-manager.ts:166` tests for.
     */
    rateLimitRps: doublePrecision(),
    rateLimitRpm: doublePrecision(),
    rateLimitRph: doublePrecision(),
    rateLimitRpd: doublePrecision(),
    rateLimitTps: doublePrecision(),
    rateLimitTpm: doublePrecision(),
    rateLimitTph: doublePrecision(),
    rateLimitTpd: doublePrecision(),

    isActive: boolean().notNull().default(true),
    isPaid: boolean().notNull().default(false),
    tier: text().notNull().default('free'),

    /** Dynamic rotation: bumped past the group max on failure, restored on success. */
    currentPriority: doublePrecision().notNull().default(10),
    originalPriority: doublePrecision().notNull().default(10),

    /** `null` means unlimited — `key-manager.ts:260` tests `!= null`, not falsiness. */
    creditLimitUSD: doublePrecision(),
    spentUSD: doublePrecision().notNull().default(0),

    lastUsedAt: timestamptz(),
    lastSuccessAt: timestamptz(),
    totalRequests: bigint({ mode: 'number' }).notNull().default(0),
    totalTokens: bigint({ mode: 'number' }).notNull().default(0),
    successCount: bigint({ mode: 'number' }).notNull().default(0),

    consecutiveFailures: integer().notNull().default(0),
    totalFailures: bigint({ mode: 'number' }).notNull().default(0),
    lastFailureAt: timestamptz(),
    lastFailureReason: text(),
    cooldownUntil: timestamptz(),
    rateLimitResetMs: doublePrecision(),

    maxTotalFailures: doublePrecision().notNull().default(100),
    isArchived: boolean().notNull().default(false),
    archivedAt: timestamptz(),
    archivedReason: text(),

    rotatedAt: timestamptz(),
    expiresAt: timestamptz(),
    rotationSchedule: text().notNull().default('manual'),

    /** Oxy user id. Text, not a uuid and not a foreign key — no users table here. */
    ownerId: text(),
    /**
     * `ref: 'Organization'` in Mongo, but this service has no Organization
     * model (only `models/organization-member.ts`), so there is nothing to
     * point a foreign key at. Plain text, same as `ownerId`.
     */
    organizationId: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The deduplication lookup and the unique, in one index.
    uniqueIndex('provider_keys_key_hash_key').on(t.keyHash),
    // `key-manager.ts:89` — the selection query, plus its rotation ordering.
    index('provider_keys_provider_active_archived_priority_idx').on(
      t.provider,
      t.isActive,
      t.isArchived,
      t.currentPriority,
    ),
    index('provider_keys_environment_active_idx').on(t.environment, t.isActive),
    /**
     * Mongo declares these two `{ sparse: true }` (`provider-key.ts:251-252`).
     * They are PLAIN indexes here and must stay that way. A Mongo sparse index
     * omits documents missing the field; a Postgres b-tree indexes nulls and
     * needs no predicate to behave. Adding `where ... is not null` would embed
     * a false belief about Postgres in the schema — and it is a DIFFERENT trap
     * from the sparse-UNIQUE one, where the predicate really is required.
     * Neither of these is unique.
     */
    index('provider_keys_owner_idx').on(t.ownerId),
    index('provider_keys_organization_idx').on(t.organizationId),

    check('provider_keys_provider', sql`${t.provider} in (${sql.raw(inList(PROVIDER_NAMES))})`),
    check(
      'provider_keys_environment',
      sql`${t.environment} in (${sql.raw(inList(KEY_ENVIRONMENTS))})`,
    ),
    check('provider_keys_tier', sql`${t.tier} in (${sql.raw(inList(KEY_TIERS))})`),
    check(
      'provider_keys_rotation_schedule',
      sql`${t.rotationSchedule} in (${sql.raw(inList(KEY_ROTATION_SCHEDULES))})`,
    ),
    check('provider_keys_name_length', sql`char_length(${t.name}) <= ${sql.raw(String(KEY_NAME_MAX))}`),
    check(
      'provider_keys_key_prefix_length',
      sql`char_length(${t.keyPrefix}) <= ${sql.raw(String(KEY_PREFIX_MAX))}`,
    ),
    check(
      'provider_keys_last_failure_reason_length',
      sql`char_length(${t.lastFailureReason}) <= ${sql.raw(String(FAILURE_REASON_MAX))}`,
    ),
    check(
      'provider_keys_archived_reason_length',
      sql`char_length(${t.archivedReason}) <= ${sql.raw(String(FAILURE_REASON_MAX))}`,
    ),
    check('provider_keys_spent_usd', sql`${t.spentUSD} >= 0`),
    check('provider_keys_current_priority', sql`${t.currentPriority} between 1 and 1000`),
    check('provider_keys_original_priority', sql`${t.originalPriority} between 1 and 100`),
    check('provider_keys_max_total_failures', sql`${t.maxTotalFailures} between 10 and 1000`),
  ],
);

/**
 * Per-request usage rows, read only by the rate-limit check.
 *
 * ## This table has NO expiry, and that is measured rather than assumed
 *
 * `internal/providers/models/api-usage.ts` declared no `expireAfterSeconds` —
 * that file is DELETED as of the providers rewiring, so read it at f7834e8; the
 * whole-repo census finds five TTL indexes and this is not one of them. The
 * 90-day TTL that looks like it belongs here is the billing domain's own, on
 * `api_key_usage`. So this table gets no expiry
 * registry entry: inventing a 90-day retention would be a new invariant that
 * silently starts deleting rows nobody agreed to delete.
 *
 * It is worth saying plainly that this is unbounded growth with a ONE-DAY read
 * window (`key-manager.ts:204` never looks back further), so a retention policy
 * is very likely wanted — as a decision taken on purpose, not as a side effect
 * of a port.
 */
export const apiUsages = pgTable(
  'api_usages',
  {
    id: generatedId(),
    /**
     * A real foreign key, and deliberately so.
     *
     * A request can race a key deletion and present an id that no longer
     * exists. Without a foreign key Postgres would happily store that dangling
     * id — turning a loud failure into a silent one, which is the direction
     * that must never be taken by accident. The FK keeps the failure loud.
     */
    keyId: text()
      .notNull()
      .references(() => providerKeys.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    modelId: text().notNull(),
    tokens: bigint({ mode: 'number' }).notNull().default(0),
    timestamp: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    // The rate-limit window scan.
    index('api_usages_key_timestamp_idx').on(t.keyId, t.timestamp.desc()),
    index('api_usages_provider_idx').on(t.provider),
    index('api_usages_timestamp_idx').on(t.timestamp),
  ],
);

/**
 * One row per request that went through the fallback engine.
 *
 * TTL in Mongo: 30 days on `timestamp` (`fallback-event.ts:46`). Postgres has
 * no TTL index, so this table is a registered target of the expiry sweep — see
 * `src/lib/expiry-targets.ts`. Deleting a row is pure analytics loss: nothing
 * reads a fallback event to make a decision, and `routes/fallback-stats.ts`
 * caps its own window at 30 days anyway, so a not-yet-swept row is never
 * unsafe.
 */
export const fallbackEvents = pgTable(
  'fallback_events',
  {
    id: generatedId(),
    timestamp: timestamptz().notNull().defaultNow(),
    clarityModel: text().notNull(),
    finalProvider: text(),
    finalModel: text(),
    success: boolean().notNull(),
    totalLatencyMs: doublePrecision(),
  },
  (t) => [
    index('fallback_events_clarity_model_timestamp_idx').on(t.clarityModel, t.timestamp.desc()),
    index('fallback_events_success_timestamp_idx').on(t.success, t.timestamp.desc()),
    // The sweep's own predicate column.
    index('fallback_events_timestamp_idx').on(t.timestamp),
  ],
);

/**
 * `fallbackEvents.attempts`, extracted.
 *
 * A child table rather than `jsonb` because two of the four analytics
 * aggregates `$unwind` it (`routes/fallback-stats.ts:60` and `:83`) and a third
 * takes its `$size`. `position` is stored explicitly: Mongo array order is the
 * insertion order the writer built (`fallback-engine.ts:376`), and a Postgres
 * child table has no order of its own, so the ordering has to become a column
 * or it is lost.
 *
 * No member of the sub-document is `required` in Mongo and none carries a
 * `maxlength`, so every column is nullable and none gets a CHECK — the writer's
 * `error.substring(0, 500)` is a writer's choice, not a validator that ran.
 */
export const fallbackEventAttempts = pgTable(
  'fallback_event_attempts',
  {
    id: generatedId(),
    eventId: text()
      .notNull()
      .references(() => fallbackEvents.id, { onDelete: 'cascade' }),
    /** 0-based index within the source array. */
    position: integer().notNull(),
    provider: text(),
    model: text(),
    error: text(),
    reason: text(),
    latencyMs: doublePrecision(),
  },
  (t) => [
    uniqueIndex('fallback_event_attempts_event_position_key').on(t.eventId, t.position),
    index('fallback_event_attempts_reason_idx').on(t.reason),
    index('fallback_event_attempts_provider_idx').on(t.provider),
    check('fallback_event_attempts_position', sql`${t.position} >= 0`),
  ],
);

/** Concrete provider models the router can reach. */
export const modelConfigs = pgTable(
  'model_configs',
  {
    id: generatedId(),
    modelId: text().notNull(),
    provider: text().notNull(),
    displayName: text().notNull(),

    clarityTier: text(),
    priority: doublePrecision(),
    qualityScore: doublePrecision(),

    // `capabilities`, flattened. Defaults match `model-config.ts:123-134`:
    // streaming and functionCalling default TRUE, the other eight FALSE.
    capVision: boolean().notNull().default(false),
    capAudio: boolean().notNull().default(false),
    capCodeExecution: boolean().notNull().default(false),
    capWebSearch: boolean().notNull().default(false),
    capComputerUse: boolean().notNull().default(false),
    capThinking: boolean().notNull().default(false),
    capStreaming: boolean().notNull().default(true),
    capFunctionCalling: boolean().notNull().default(true),
    capJsonMode: boolean().notNull().default(false),
    capPromptCaching: boolean().notNull().default(false),

    // `limits`, flattened. The two required members stay NOT NULL.
    limitMaxContextTokens: doublePrecision().notNull(),
    limitMaxOutputTokens: doublePrecision().notNull(),
    limitMaxImages: doublePrecision(),
    limitMaxAudioSeconds: doublePrecision(),

    // `pricing`, flattened.
    pricingTier: text().notNull(),
    pricingCostPer1MInput: doublePrecision().notNull(),
    pricingCostPer1MOutput: doublePrecision().notNull(),
    pricingCostPer1MCachedInput: doublePrecision(),
    pricingAverageLatencyMs: doublePrecision().notNull(),

    // `defaultConfig`, flattened. Optional in full.
    defaultTemperature: doublePrecision(),
    defaultTopP: doublePrecision(),
    defaultMaxTokens: doublePrecision(),
    defaultSystemPrompt: text(),

    isActive: boolean().notNull().default(true),
    isDeprecated: boolean().notNull().default(false),
    deprecationDate: timestamptz(),
    replacementModelId: text(),

    description: text(),
    providerUrl: text(),
    notes: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('model_configs_provider_model_key').on(t.provider, t.modelId),
    index('model_configs_clarity_tier_priority_idx').on(t.clarityTier, t.priority),
    index('model_configs_active_deprecated_idx').on(t.isActive, t.isDeprecated),
    check('model_configs_provider', sql`${t.provider} in (${sql.raw(inList(PROVIDER_NAMES))})`),
    // Nullable: a CHECK rejects only FALSE, and `null in (...)` is NULL, so an
    // unset tier passes without needing an `is null or` arm.
    check('model_configs_clarity_tier', sql`${t.clarityTier} in (${sql.raw(inList(CLARITY_TIERS))})`),
    check('model_configs_pricing_tier', sql`${t.pricingTier} in (${sql.raw(inList(PRICING_TIERS))})`),
    check('model_configs_priority', sql`${t.priority} between 1 and 100`),
    check('model_configs_quality_score', sql`${t.qualityScore} between 0 and 100`),
    check(
      'model_configs_description_length',
      sql`char_length(${t.description}) <= ${sql.raw(String(DESCRIPTION_MAX))}`,
    ),
    check(
      'model_configs_provider_url_length',
      sql`char_length(${t.providerUrl}) <= ${sql.raw(String(PROVIDER_URL_MAX))}`,
    ),
    check('model_configs_notes_length', sql`char_length(${t.notes}) <= ${sql.raw(String(NOTES_MAX))}`),
  ],
);

/** Virtual Clarity models — what a caller names, mapped onto provider models. */
export const clarityModels = pgTable(
  'clarity_models',
  {
    id: generatedId(),
    clarityModelId: text().notNull(),
    displayName: text().notNull(),
    tier: text().notNull(),
    description: text(),
    features: text().array().notNull().default(sql`'{}'::text[]`),

    creditMultiplier: doublePrecision().notNull().default(1),
    isFreeTier: boolean().notNull().default(true),

    // `aggregatedCapabilities`, flattened — five members, all defaulting false.
    capVision: boolean().notNull().default(false),
    capAudio: boolean().notNull().default(false),
    capCodeExecution: boolean().notNull().default(false),
    capWebSearch: boolean().notNull().default(false),
    capThinking: boolean().notNull().default(false),

    isActive: boolean().notNull().default(true),
    isDeprecated: boolean().notNull().default(false),
    isLegacy: boolean().notNull().default(false),
    deprecationDate: timestamptz(),
    replacementModelId: text(),

    totalRequests: bigint({ mode: 'number' }).notNull().default(0),
    totalTokens: bigint({ mode: 'number' }).notNull().default(0),
    averageLatencyMs: doublePrecision().notNull().default(0),

    notes: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Functional, because the uniqueness is what the `lowercase: true` setter
    // was upholding. See the file header.
    // See the file header for why this is a plain unique plus a CHECK rather
    // than a functional index over `lower(...)`.
    unique('clarity_models_clarity_model_id_key').on(t.clarityModelId),
    check('clarity_models_clarity_model_id_lower', sql`${t.clarityModelId} = lower(${t.clarityModelId})`),
    index('clarity_models_tier_active_idx').on(t.tier, t.isActive),
    index('clarity_models_active_deprecated_idx').on(t.isActive, t.isDeprecated),
    check('clarity_models_tier', sql`${t.tier} in (${sql.raw(inList(CLARITY_TIERS))})`),
    check('clarity_models_credit_multiplier', sql`${t.creditMultiplier} between 0.1 and 10`),
    check(
      'clarity_models_description_length',
      sql`char_length(${t.description}) <= ${sql.raw(String(DESCRIPTION_MAX))}`,
    ),
    check('clarity_models_notes_length', sql`char_length(${t.notes}) <= ${sql.raw(String(NOTES_MAX))}`),
  ],
);

/**
 * `clarityModels.providerMappings`, extracted.
 *
 * ## The foreign key to `model_configs` is a deliberate tightening
 *
 * In Mongo `modelConfigId` is a `required: true` ref, and every writer resolves
 * a real `ModelConfig` first (`routes/clarity-models.ts:127` and `:200` return
 * 400 when the lookup misses; `seed-model-configs.ts:170` only pushes a mapping
 * when one is found). So "this points at a real provider model" was already an
 * invariant at write time — Mongo simply could not hold it at DELETE time, and
 * `DELETE /v1/models/:provider/:modelId` leaves dangling mappings today.
 *
 * `onDelete: 'restrict'` rather than `cascade`, chosen by naming the failure
 * each produces: cascade silently strips a fallback rung from every Clarity
 * model that used it, discovered later as degraded routing; restrict fails the
 * delete loudly, in an admin route, where it can be fixed by unmapping first.
 * **This changes that route's behaviour** and the rewiring commit has to say so
 * — it is listed in the port report rather than left to be found at cutover.
 *
 * ## Replacing the set is not a plain DELETE + INSERT
 *
 * `PATCH /v1/clarity-models/:id` sets the whole array in one atomic Mongo
 * `$set`. Here that becomes DELETE-then-INSERT, and the gap between them is a
 * real state in which the Clarity model has NO providers — a router reading it
 * in that window falls back to nothing. `replaceProviderMappings` therefore
 * takes a transaction handle, refuses to run without one, and takes
 * `SELECT ... FOR UPDATE` on the parent row first: a transaction alone gives
 * atomicity, not the SERIALIZATION the single document used to give, so two
 * concurrent replaces under READ COMMITTED would otherwise leave the union of
 * both.
 */
export const clarityModelProviderMappings = pgTable(
  'clarity_model_provider_mappings',
  {
    id: generatedId(),
    clarityModelId: text()
      .notNull()
      .references(() => clarityModels.id, { onDelete: 'cascade' }),
    modelConfigId: text()
      .notNull()
      .references(() => modelConfigs.id, { onDelete: 'restrict' }),
    provider: text().notNull(),
    modelId: text().notNull(),
    priority: doublePrecision().notNull(),
    qualityScore: doublePrecision().notNull(),
    isActive: boolean().notNull().default(true),
    /** 0-based index within the source array — see `fallbackEventAttempts.position`. */
    position: integer().notNull(),
  },
  (t) => [
    uniqueIndex('clarity_model_provider_mappings_model_position_key').on(
      t.clarityModelId,
      t.position,
    ),
    // `getAvailableProviders()` — active mappings, by priority.
    index('clarity_model_provider_mappings_model_active_priority_idx').on(
      t.clarityModelId,
      t.isActive,
      t.priority,
    ),
    index('clarity_model_provider_mappings_model_config_idx').on(t.modelConfigId),
    check('clarity_model_provider_mappings_priority', sql`${t.priority} between 1 and 100`),
    check('clarity_model_provider_mappings_quality_score', sql`${t.qualityScore} between 0 and 100`),
    check('clarity_model_provider_mappings_position', sql`${t.position} >= 0`),
  ],
);

/** Subscription plan definitions. */
export const plans = pgTable(
  'plans',
  {
    id: generatedId(),
    planId: text().notNull(),
    name: text().notNull(),
    product: text().notNull(),

    creditsPerMonth: doublePrecision().notNull().default(0),
    dailyFreeCredits: doublePrecision().notNull().default(300),
    monthlyPrice: doublePrecision().notNull().default(0),
    annualPrice: doublePrecision().notNull().default(0),
    currency: text().notNull().default('usd'),

    subtitle: text().notNull().default(''),
    creditsLabel: text().notNull().default(''),
    isFeatured: boolean().notNull().default(false),
    sortOrder: doublePrecision().notNull().default(0),
    /**
     * `ClarityModel.clarityModelId`s included in the plan. A `text[]`, not a
     * junction table: nothing joins on it, it is read whole, and the only
     * validation is a membership check the route already performs.
     */
    modelIds: text().array().notNull().default(sql`'{}'::text[]`),

    isActive: boolean().notNull().default(true),
    isFree: boolean().notNull().default(false),

    stripeProductId: text(),
    stripeMonthlyPriceId: text(),
    stripeAnnualPriceId: text(),

    description: text(),
    notes: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('plans_plan_id_key').on(t.planId),
    check('plans_plan_id_lower', sql`${t.planId} = lower(${t.planId})`),
    index('plans_product_sort_idx').on(t.product, t.sortOrder),
    index('plans_product_active_idx').on(t.product, t.isActive),
    check('plans_product', sql`${t.product} in (${sql.raw(inList(PLAN_PRODUCTS))})`),
    check(
      'plans_description_length',
      sql`char_length(${t.description}) <= ${sql.raw(String(DESCRIPTION_MAX))}`,
    ),
    check('plans_notes_length', sql`char_length(${t.notes}) <= ${sql.raw(String(NOTES_MAX))}`),
  ],
);

/** Canonical feature definitions, for plan comparison and entitlements. */
export const features = pgTable(
  'features',
  {
    id: generatedId(),
    featureId: text().notNull(),
    label: text().notNull(),
    description: text(),
    icon: text(),
    category: text().notNull(),
    featureType: text().notNull().default('boolean'),
    sortOrder: doublePrecision().notNull().default(0),
    isVisibleOnPricing: boolean().notNull().default(true),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('features_feature_id_key').on(t.featureId),
    check('features_feature_id_lower', sql`${t.featureId} = lower(${t.featureId})`),
    index('features_category_sort_idx').on(t.category, t.sortOrder),
    check('features_feature_type', sql`${t.featureType} in (${sql.raw(inList(FEATURE_TYPES))})`),
  ],
);

/**
 * Plan-to-feature junction.
 *
 * `planId` and `featureId` are plain strings with NO foreign keys, matching the
 * source. Adding them would be inventing an invariant: the Mongo schema
 * declares no `ref`, and both the matrix editor's bulk upsert
 * (`routes/plan-features.ts:107`) and the seed (`seed-features.ts:283`) write
 * mappings without checking that either side exists. A foreign key would also
 * have to target `plans.planId` / `features.featureId`, whose uniqueness lives
 * in a FUNCTIONAL index — not a `unique()` and not a primary key, so it cannot
 * be an FK target at all.
 */
export const planFeatures = pgTable(
  'plan_features',
  {
    id: generatedId(),
    planId: text().notNull(),
    featureId: text().notNull(),
    enabled: boolean().notNull().default(true),
    limitValue: doublePrecision(),
    displayLabel: text(),
    displayDescription: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('plan_features_plan_feature_key').on(t.planId, t.featureId),
    index('plan_features_feature_idx').on(t.featureId),
  ],
);

/** One-time credit purchase packages. */
export const creditPackages = pgTable(
  'credit_packages',
  {
    id: generatedId(),
    packageId: text().notNull(),
    name: text().notNull(),
    credits: doublePrecision().notNull(),
    /** In cents. */
    price: doublePrecision().notNull(),
    currency: text().notNull().default('usd'),
    stripePriceId: text(),
    sortOrder: doublePrecision().notNull().default(0),
    isActive: boolean().notNull().default(true),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('credit_packages_package_id_key').on(t.packageId),
    check('credit_packages_package_id_lower', sql`${t.packageId} = lower(${t.packageId})`),
    index('credit_packages_active_sort_idx').on(t.isActive, t.sortOrder),
    check('credit_packages_credits', sql`${t.credits} >= 1`),
    check('credit_packages_price', sql`${t.price} >= 0`),
    check(
      'credit_packages_description_length',
      sql`char_length(${t.description}) <= ${sql.raw(String(DESCRIPTION_MAX))}`,
    ),
  ],
);

/**
 * Per-request cost ledger. Declared INLINE in `src/lib/cost-tracker.ts:65`
 * rather than under a `models/` directory, so no census scoped to `models/`
 * would have found it.
 *
 * `actualProvider` and `actualModelId` are internal-only, and the source says
 * so at `cost-tracker.ts:303`. Only the admin/global reader may group by them;
 * no repository method here returns them on a per-user path.
 */
export const costEntries = pgTable(
  'cost_entries',
  {
    id: generatedId(),
    userId: text().notNull(),
    sessionId: text(),
    /** What the caller asked for. Safe to show. */
    clarityModelId: text().notNull(),
    /** Internal only — never reaches a user-facing response. */
    actualProvider: text().notNull(),
    /** Internal only — never reaches a user-facing response. */
    actualModelId: text().notNull(),
    inputTokens: bigint({ mode: 'number' }).notNull(),
    outputTokens: bigint({ mode: 'number' }).notNull(),
    totalTokens: bigint({ mode: 'number' }).notNull(),
    costUSD: doublePrecision().notNull(),
    savedFromCache: boolean().notNull().default(false),
    timestamp: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('cost_entries_user_timestamp_idx').on(t.userId, t.timestamp.desc()),
    index('cost_entries_clarity_model_timestamp_idx').on(t.clarityModelId, t.timestamp.desc()),
    index('cost_entries_user_clarity_model_idx').on(t.userId, t.clarityModelId),
    index('cost_entries_session_idx').on(t.sessionId),
    index('cost_entries_timestamp_idx').on(t.timestamp),
  ],
);

/**
 * Hourly auth success/failure buckets. Declared INLINE in
 * `src/lib/auth-health.ts:56` — the second model no `models/` census can see.
 *
 * TTL in Mongo: 7 days on `createdAt` (`auth-health.ts:53`), so this is the
 * second registered expiry target. Sweeping is pure metric loss; the reader
 * caps its own window at 168 hours (`routes/auth-health.ts:23`), well inside
 * the retention.
 */
export const authHealthMetrics = pgTable(
  'auth_health_metrics',
  {
    id: generatedId(),
    method: text().notNull(),
    /**
     * Start of the hour bucket, floored in LOCAL time by
     * `getBucketedHour()` (`auth-health.ts:65`). Stored as `timestamptz`, which
     * keeps the instant that function produced — the local-time flooring is the
     * caller's, and moving it into SQL would change which bucket a row lands in.
     */
    hour: timestamptz().notNull(),
    successes: bigint({ mode: 'number' }).notNull().default(0),
    failures: bigint({ mode: 'number' }).notNull().default(0),
    lastFailure: timestamptz(),
    lastFailureReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('auth_health_metrics_method_hour_key').on(t.method, t.hour),
    index('auth_health_metrics_hour_idx').on(t.hour),
    // The sweep's own predicate column.
    index('auth_health_metrics_created_at_idx').on(t.createdAt),
  ],
);

/**
 * Circuit-breaker state per provider/model. Was declared INLINE in
 * `src/internal/providers/lib/provider-health.ts:68` — the third invisible
 * model, and the one also retrieved by BARE NAME STRING
 * (`mongoose.models.ProviderHealth` at `routes/providers.ts:342` and
 * `seed-model-configs.ts:244`), a shape no import census can see at all. Both
 * of those sites guarded on the model being absent and quietly did nothing;
 * against a table that guard has no meaning, so the rewiring DROPPED it rather
 * than porting it — "the model was not registered" and "there was nothing to
 * reset" must not stay the same silent outcome. Done: both sites now call
 * `resetAll` / `resetOpenCircuits` unguarded. Line numbers are as of f7834e8.
 */
export const providerHealths = pgTable(
  'provider_healths',
  {
    id: generatedId(),
    provider: text().notNull(),
    modelId: text().notNull(),
    successCount: bigint({ mode: 'number' }).notNull().default(0),
    failureCount: bigint({ mode: 'number' }).notNull().default(0),
    totalRequests: bigint({ mode: 'number' }).notNull().default(0),
    /** 0-100. Recomputed on every write, never derived at read time. */
    successRate: doublePrecision().notNull().default(100),
    averageLatencyMs: doublePrecision().notNull().default(0),
    /**
     * The last 100 latencies, trimmed by the writer. An ARRAY, not a child
     * table: it is a bounded ring buffer that is never filtered, joined or
     * ordered — only reduced to `averageLatencyMs` — and a child table would
     * turn one row update into a hundred.
     */
    latencySamples: doublePrecision().array().notNull().default(sql`'{}'::double precision[]`),
    lastSuccess: timestamptz(),
    lastFailure: timestamptz(),
    consecutiveFailures: integer().notNull().default(0),
    consecutiveSuccesses: integer().notNull().default(0),
    circuitState: text().notNull().default('closed'),
    circuitOpenedAt: timestamptz(),
    halfOpenAttempts: integer().notNull().default(0),
    lastHealthCheck: timestamptz().notNull().defaultNow(),
    isHealthy: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('provider_healths_provider_model_key').on(t.provider, t.modelId),
    // `startHealthCheckMonitor()` scans open and half-open circuits only.
    index('provider_healths_circuit_state_idx').on(t.circuitState),
    // `getAllProviderHealth()` sorts by `updatedAt` descending.
    index('provider_healths_updated_at_idx').on(t.updatedAt.desc()),
    /**
     * `circuitState` gets a CHECK because Mongo declares an `enum` for it
     * (`provider-health.ts:55`). `provider` does NOT, even though every writer
     * passes a `PROVIDER_NAMES` value: converting a validator that never
     * existed into a live constraint is a behaviour change dressed as fidelity,
     * and it would start rejecting rows the source accepts.
     */
    check('provider_healths_circuit_state', sql`${t.circuitState} in (${sql.raw(inList(CIRCUIT_STATES))})`),
  ],
);
