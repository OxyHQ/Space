import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * Billing — credits, subscriptions, transactions, usage metering and feedback.
 *
 * Conventions are the ones `workspaces.ts` documents; only what is SPECIFIC to
 * this domain is explained here. This is the money domain, so the standing
 * question at every column is not "does this work" but "what does a wrong
 * answer look like" — and the answer that matters is the one that is silent.
 */

/* ------------------------------------------------------------------ credits */

/**
 * The Mongoose `credits` sub-document becomes COLUMNS, not `jsonb`.
 *
 * Forced by the writers rather than chosen for tidiness: `reserveCredits`
 * (`lib/credits-manager.ts:87`) is a conditional compare-and-set that reads
 * `credits.free` and `credits.paid`, compares their SUM against an amount and
 * writes both back in one statement. That is an ordinary `UPDATE ... WHERE`
 * over columns and a pile of casts over `jsonb`.
 *
 * The consequence is the dangerous half, and it is why the reader list below
 * exists. A missed `Model.verb()` throws; a missed document-SHAPE read does
 * not. `doc.credits.free` against a row whose sub-document became columns
 * reads `undefined`, and every reader of this table spells the fallback
 * `|| 0` — so a balance does not error, it silently becomes ZERO.
 * `lib/credit-anomaly.ts:29-31` is the measured instance:
 * `userCredits?.credits?.free || 0`, three times, feeding a
 * "days of credit remaining" figure that would read 0 and warn every user
 * that they are out of money.
 *
 * EVERY reader of the document shape, as of this commit. A rewiring PR must
 * touch all of them; none of them imports this model, so no import census
 * finds them:
 *   - routes/credits.ts:18-23        free, paid, freeLimit, dailyRefresh, lastRefresh
 *   - routes/v1.ts:66-68             free, paid
 *   - lib/credits-manager.ts:124     free, paid   (log line)
 *   - lib/credits-manager.ts:129-130 free, paid   (reservation snapshot)
 *   - lib/credits-manager.ts:214-215 free, paid
 *   - lib/credits-manager.ts:289-291 free, paid
 *   - lib/credit-anomaly.ts:29-31    free, paid, dailyRefresh   (the `|| 0` case)
 *   - routes/billing.ts:39           stripeCustomerId
 *   - routes/billing.ts:64-65        stripeCustomerId, then `.save()`
 *   - routes/billing.ts:670-672      stripeCustomerId, then `.save()`
 *   - routes/billing.ts:698,719,740  `userCredits._id` used as the oxy user id
 * and the instance methods, whose call sites are equally invisible:
 *   - routes/billing.ts:627,729      `.addCredits(n, 'paid')`
 *   - routes/v1.ts:55                `.refreshCreditsIfNeeded()`
 *   - routes/credits.ts:15           `.refreshCreditsIfNeeded()`
 *   - services/chat.service.ts:127   `.refreshCreditsIfNeeded()`
 */
export const userCredits = pgTable(
  'user_credits',
  {
    /**
     * The Oxy user id, exactly as Mongo's `_id` held it — NOT `generatedId()`.
     * This table has never had a surrogate key: `UserCredits.findById(userId)`
     * IS the lookup, and `userCredits._id` is read back out as the user id at
     * `routes/billing.ts:698`, `:719` and `:740`.
     */
    id: text().primaryKey(),

    creditsFree: integer().notNull().default(300),
    creditsFreeLimit: integer().notNull().default(300),
    creditsDailyRefresh: integer().notNull().default(300),
    creditsPaid: integer().notNull().default(0),
    creditsLastRefresh: timestamptz().notNull().defaultNow(),

    /**
     * Written by `lib/credits-manager.ts:111` and read by nothing.
     *
     * It is not in the Mongoose schema either — that statement is an
     * aggregation-pipeline update, which bypasses strict mode, so
     * `'credits.lastUsed': new Date()` has been landing in production
     * documents as an undeclared field. Carried across because dropping a
     * column the port's own writer still writes is how a writer/column diff
     * comes back non-empty later; it is nullable because every row written by
     * any other path lacks it.
     */
    creditsLastUsed: timestamptz(),

    stripeCustomerId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * `findOne({ stripeCustomerId })` at `routes/billing.ts:665`. Mongo's
     * index is `{ stripeCustomerId: 1 }, { sparse: true }` — sparse, NOT
     * unique — so this stays non-unique. Two rows sharing a Stripe customer
     * would be a bug, but the source has never refused one and the port is
     * not the place to invent the constraint; `sparse` itself needs no
     * partial predicate here, since a Postgres index simply indexes the nulls.
     */
    index('user_credits_stripe_customer_idx').on(t.stripeCustomerId),

    /**
     * A DELIBERATE tightening, and the only one on this table.
     *
     * Non-negativity is an invariant every existing writer already upholds —
     * `deductCredits` guards `total >= amount`, `reserveCredits` guards
     * `free + paid >= amount` and clamps `free` to 0, `addCredits` and the
     * refund path only increase — so this makes an EXISTING property
     * structural rather than inventing a new one. It earns its place because
     * it fails loudly in exactly the case the CAS ports wrong: a guard that
     * stops guarding produces a negative balance, which is silent, arithmetic
     * everywhere downstream, and indistinguishable from a small balance.
     *
     * `repositories/userCredits.ts` has a test asserting an over-deduction is
     * REFUSED rather than being allowed to write a negative row.
     */
    check('user_credits_non_negative', sql`${t.creditsFree} >= 0 and ${t.creditsPaid} >= 0`),
  ],
);

/* ------------------------------------------------------------ subscriptions */

/**
 * `paused` is NOT in the Mongoose enum, and is included here on purpose.
 *
 * `handleSubscriptionUpdate` (`routes/billing.ts:695`) writes
 * `status: stripeSubscription.status` through `findOneAndUpdate`, which does
 * not run validators — so the enum has never been enforced on the only path
 * that sets this field from Stripe. Stripe's own `Subscription.Status` union
 * (`stripe/types/Subscriptions.d.ts:799-807`) carries eight values including
 * `paused`; the Mongoose enum lists seven and omits it.
 *
 * A CHECK built from the Mongoose enum alone would therefore REJECT a status
 * that stores successfully today, turning a routine webhook into a 500 and a
 * Stripe retry storm. Converting a dead validator into a live constraint is
 * only safe once the constraint admits everything the writer can produce.
 */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'canceled',
  'past_due',
  'unpaid',
  'trialing',
  'incomplete',
  'incomplete_expired',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_PERIODS = ['monthly', 'annual'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const SUBSCRIPTION_PRODUCTS = ['clarity', 'codea'] as const;
export type SubscriptionProduct = (typeof SUBSCRIPTION_PRODUCTS)[number];

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    stripeCustomerId: text().notNull(),
    stripeSubscriptionId: text().notNull(),
    stripePriceId: text().notNull(),
    status: text().notNull(),
    currentPeriodStart: timestamptz().notNull(),
    currentPeriodEnd: timestamptz().notNull(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    planId: text(),
    billingPeriod: text().notNull().default('monthly'),

    /**
     * The `plan` sub-document, flattened. It is a SNAPSHOT of the gateway plan
     * at write time, not a reference, so it stays on the row.
     *
     * Flattened rather than `jsonb` because `plan.product` is a QUERY key:
     * `routes/billing.ts:334` and `:387` filter on it and Mongo indexes it
     * (`{ oxyUserId: 1, 'plan.product': 1, status: 1 }`). A `jsonb` column
     * would need an expression index and could carry no CHECK.
     *
     * All six are NULLABLE even though Mongoose marks `name`,
     * `creditsPerMonth` and `price` as `required`, because that validator is
     * live on only one of the two writers. `subscription.plan = {...};
     * save()` (`routes/billing.ts:504-513`) runs it; the webhook upsert at
     * `:695` does not — and there `price` is
     * `isAnnual ? plan.annualPrice : plan.monthlyPrice`, which is `undefined`
     * for a gateway plan with no annual price. Mongo treats `$set: undefined`
     * as a no-op and stores the field absent; NOT NULL would instead throw
     * inside a Stripe webhook, so a customer who has paid gets no
     * subscription row at all. Both readers already expect the absence:
     * `middleware/api-key-rate-limit.ts:88` spells it
     * `subscription.plan?.name?.toLowerCase() || ''` and
     * `lib/plan-access.ts:31` spells it `s.plan?.planId` behind a
     * `.filter(Boolean)`.
     */
    planPlanId: text(),
    planName: text(),
    planProduct: text().default('clarity'),
    planCreditsPerMonth: integer(),
    /** Cents, like every other money amount here. See `transactions.amount`. */
    planPrice: integer(),
    planCurrency: text().default('usd'),
    planBillingPeriod: text().default('monthly'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * `unique: true` in Mongoose, and the upsert key of the webhook path
     * (`findOneAndUpdate({ stripeSubscriptionId }, ..., { upsert: true })`).
     * Named, because `repositories/subscriptions.ts` answers for THIS
     * constraint by name when an upsert races itself.
     */
    uniqueIndex('subscriptions_stripe_subscription_id_key').on(t.stripeSubscriptionId),

    index('subscriptions_user_status_idx').on(t.oxyUserId, t.status),
    index('subscriptions_user_product_status_idx').on(t.oxyUserId, t.planProduct, t.status),
    index('subscriptions_stripe_customer_idx').on(t.stripeCustomerId),
    index('subscriptions_plan_idx').on(t.planId),
    /**
     * `getUserTier` sorts by `createdAt: -1` after filtering on user + status
     * (`middleware/api-key-rate-limit.ts:79-82`), and `billing-admin.ts:96`
     * lists a user's subscriptions newest-first. Ported deliberately: an index
     * is the one thing whose absence no functional test can ever detect —
     * a sequential scan returns exactly the right row.
     */
    index('subscriptions_user_created_idx').on(t.oxyUserId, t.createdAt.desc()),

    check('subscriptions_status', sql`${t.status} in (${sql.raw(inList(SUBSCRIPTION_STATUSES))})`),
    check(
      'subscriptions_billing_period',
      sql`${t.billingPeriod} in (${sql.raw(inList(BILLING_PERIODS))})`,
    ),
    /**
     * Nullable columns, so the CHECK must admit NULL explicitly — a bare
     * `in (...)` is NULL, not FALSE, and a CHECK rejects only FALSE, so it
     * would pass anyway; spelled out so a later reader does not "fix" it into
     * something that rejects the legitimate absent case.
     */
    check(
      'subscriptions_plan_product',
      sql`${t.planProduct} is null or ${t.planProduct} in (${sql.raw(inList(SUBSCRIPTION_PRODUCTS))})`,
    ),
    check(
      'subscriptions_plan_billing_period',
      sql`${t.planBillingPeriod} is null or ${t.planBillingPeriod} in (${sql.raw(inList(BILLING_PERIODS))})`,
    ),
  ],
);

/* ------------------------------------------------------------- transactions */

export const TRANSACTION_TYPES = ['credit_purchase', 'subscription_payment', 'refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const transactions = pgTable(
  'transactions',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    stripeCustomerId: text(),
    stripePaymentIntentId: text(),
    type: text().notNull(),
    /**
     * CENTS, integer — `session.amount_total` straight from Stripe
     * (`routes/billing.ts:636`). `integer` is provably sufficient rather than
     * merely probably: Stripe caps a charge at 99999999 cents, inside int4.
     *
     * Emphatically NOT `bigint`: postgres.js decodes `int8` as a STRING while
     * drizzle types it `number`, so `sum()` over it would type-check as
     * arithmetic and concatenate at runtime.
     */
    amount: integer().notNull(),
    currency: text().notNull().default('usd'),
    credits: integer().notNull(),
    status: text().notNull().default('pending'),
    description: text(),

    /**
     * Promoted out of `metadata.dedup` to a real column with its own unique.
     *
     * Mongo indexed `{'metadata.dedup': 1}, { unique: true, sparse: true }` —
     * a unique on a field nested inside a `Mixed`. It is the idempotency key
     * for subscription credit grants: `routes/billing.ts:715` builds
     * `${subscriptionId}_${periodStart}` and relies on the insert being
     * REFUSED to avoid granting the same month's credits twice.
     *
     * No partial predicate. Mongo's `sparse: true` does not exclude a stored
     * `null` and needs `partialFilterExpression` to behave; a Postgres unique
     * is NULLS DISTINCT by default, so every dedup-less transaction coexists
     * freely and the predicate would be cargo.
     */
    dedup: text(),

    /**
     * Retained for backfill fidelity — `Schema.Types.Mixed`, so historical
     * rows may hold anything. The only key any current writer sets is
     * `dedup`, which now has its own column; a backfill must copy
     * `metadata.dedup` into it rather than relying on this.
     */
    metadata: jsonb(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Both uniques are load-bearing idempotency guards, and both are NAMED
     * because `repositories/transactions.ts` reacts differently to each:
     * a duplicate payment intent means "this checkout event was already
     * processed", a duplicate dedup key means "this subscription period was
     * already granted". `isUniqueViolation(err)` alone cannot tell them apart.
     */
    uniqueIndex('transactions_stripe_payment_intent_key').on(t.stripePaymentIntentId),
    uniqueIndex('transactions_dedup_key').on(t.dedup),

    index('transactions_user_created_idx').on(t.oxyUserId, t.createdAt.desc()),
    index('transactions_status_idx').on(t.status),

    // `Transaction.create()` runs validators, so both enums are genuinely live
    // in the source and become live constraints here.
    check('transactions_type', sql`${t.type} in (${sql.raw(inList(TRANSACTION_TYPES))})`),
    check('transactions_status', sql`${t.status} in (${sql.raw(inList(TRANSACTION_STATUSES))})`),
  ],
);

/* ------------------------------------------------------------ api key usage */

export const USAGE_AUTH_TYPES = ['api_key', 'session', 'internal'] as const;
export type UsageAuthType = (typeof USAGE_AUTH_TYPES)[number];

export const USAGE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type UsageMethod = (typeof USAGE_METHODS)[number];

/** The TTL the Mongo index expressed: 90 days. See `db/expiry-targets.ts`. */
export const API_KEY_USAGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export const apiKeyUsage = pgTable(
  'api_key_usage',
  {
    id: generatedId(),
    /**
     * Nullable — session and internal auth record usage with no key or app.
     * `text`, not a foreign key: these were `ObjectId` refs to
     * `DeveloperApiKey` / `DeveloperApp`, and no writer in this codebase has
     * ever set either (see `developerApps` below).
     */
    apiKeyId: text(),
    oxyUserId: text().notNull(),
    appId: text(),
    endpoint: text().notNull(),
    method: text().notNull(),
    statusCode: integer().notNull(),
    tokensUsed: integer().notNull().default(0),
    creditsUsed: integer().notNull().default(0),
    /** Milliseconds, always `Date.now() - startTime` (`routes/internal.ts:167`). */
    responseTime: integer(),
    userAgent: text(),
    ipAddress: text(),
    timestamp: timestamptz().notNull().defaultNow(),
    authType: text().notNull().default('api_key'),
    serviceApp: text(),
    // `timestamps: false` in the source — this table has no createdAt/updatedAt.
  },
  (t) => [
    index('api_key_usage_key_timestamp_idx').on(t.apiKeyId, t.timestamp.desc()),
    index('api_key_usage_user_timestamp_idx').on(t.oxyUserId, t.timestamp.desc()),
    index('api_key_usage_user_auth_timestamp_idx').on(t.oxyUserId, t.authType, t.timestamp.desc()),
    index('api_key_usage_app_timestamp_idx').on(t.appId, t.timestamp.desc()),
    /**
     * Replaces the Mongo TTL index's own `{ timestamp: 1 }`. Required, not
     * decorative: `sweepExpiredRows` deletes on this column and
     * `@oxyhq/db/expiry` states the retention column must be indexed.
     */
    index('api_key_usage_timestamp_idx').on(t.timestamp),

    // `ApiKeyUsage.create()` runs validators — both enums are live in Mongo.
    check('api_key_usage_method', sql`${t.method} in (${sql.raw(inList(USAGE_METHODS))})`),
    check('api_key_usage_auth_type', sql`${t.authType} in (${sql.raw(inList(USAGE_AUTH_TYPES))})`),
  ],
);

/* -------------------------------------------------------------- cost entries */


/* ------------------------------------------------------------ developer apps */

/**
 * `developer_apps` and `developer_api_keys` have ZERO call sites outside their
 * own model files — verified by grepping the symbols `DeveloperApp` and
 * `DeveloperApiKey` across `src/`, which names only `models/developer-app.ts`
 * and `models/developer-api-key.ts`. They are the residue of the legacy
 * Clarity developer portal; `api_key_usage.apiKeyId` / `.appId` are the refs
 * that pointed at them, and no writer sets either.
 *
 * Ported anyway, faithfully, because deleting a model is a decision for
 * whoever owns the rewiring, not for the port — but nothing here is exercised
 * by a real query, and `repositories/developerApps.ts` says so at its head.
 */
export const developerApps = pgTable(
  'developer_apps',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    organizationId: text(),
    name: text().notNull(),
    description: text(),
    websiteUrl: text(),
    redirectUrls: text().array().notNull().default(sql`'{}'::text[]`),
    icon: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('developer_apps_user_idx').on(t.oxyUserId),
    index('developer_apps_org_idx').on(t.organizationId),
    index('developer_apps_user_active_idx').on(t.oxyUserId, t.isActive),
    /**
     * `maxlength` on `name` (100) and `description` (500) become live CHECKs
     * because the model's only documented write path is `new DeveloperApp()`
     * + `save()`, which runs validators. With no call sites at all, the
     * faithful reading of a validator that would have run is to keep it.
     */
    check('developer_apps_name_length', sql`char_length(${t.name}) <= ${sql.raw('100')}`),
    check(
      'developer_apps_description_length',
      sql`${t.description} is null or char_length(${t.description}) <= ${sql.raw('500')}`,
    ),
  ],
);

export const API_KEY_SCOPES = [
  'chat:read',
  'chat:write',
  'models:read',
  'conversations:read',
  'conversations:write',
  'conversations:delete',
  'memory:read',
  'memory:write',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const developerApiKeys = pgTable(
  'developer_api_keys',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    appId: text()
      .notNull()
      .references(() => developerApps.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    keyHash: text().notNull(),
    keyPrefix: text().notNull(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{"chat:read","chat:write"}'::text[]`),
    expiresAt: timestamptz(),
    lastUsedAt: timestamptz(),
    isActive: boolean().notNull().default(true),

    /**
     * The `rateLimit` sub-document, flattened. NULL means UNLIMITED — that is
     * the source's own encoding (`requestsPerMinute: number | null`,
     * `null = unlimited`), so nullable columns express it exactly and a
     * `jsonb` blob would only lose the numeric type.
     */
    rateLimitRequestsPerMinute: integer(),
    rateLimitRequestsPerDay: integer().default(1000),
    rateLimitTokensPerMinute: integer(),
    rateLimitTokensPerDay: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('developer_api_keys_key_hash_key').on(t.keyHash),
    index('developer_api_keys_user_active_idx').on(t.oxyUserId, t.isActive),
    index('developer_api_keys_app_active_idx').on(t.appId, t.isActive),
    check('developer_api_keys_name_length', sql`char_length(${t.name}) <= ${sql.raw('100')}`),
    /**
     * Containment, and it is VACUOUSLY TRUE for `{}` — deliberately.
     *
     * Mongo validates the enum per ELEMENT, so an empty array has nothing to
     * reject and stores fine. Faithful. Adding a `cardinality(...) >= 1`
     * beside it would invent a constraint the source never had; the vacuity
     * is noted here so a later tidy-up does not "fix" it into one.
     */
    check(
      'developer_api_keys_scopes',
      sql`${t.scopes} <@ ${sql.raw(textArrayLiteral(API_KEY_SCOPES))}`,
    ),
  ],
);

/* ------------------------------------------------------------------ feedback */

export const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'other'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_STATUSES = ['pending', 'reviewed', 'resolved'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const feedback = pgTable(
  'feedback',
  {
    id: generatedId(),
    /**
     * `text`, though Mongoose declares `Schema.Types.ObjectId, ref: 'User'`.
     *
     * The declaration is simply wrong about what is stored: the only writer,
     * `routes/feedback.ts:36`, passes `req.user!.id` — an opaque Oxy user id —
     * and the only reader queries with the same value (`:68`, `:87`). Mongoose
     * casts it, which works while an Oxy id happens to be 24 hex characters
     * and throws a CastError when it is not. `text` matches every other Oxy
     * user id in this schema and removes the cast entirely.
     *
     * The usual direction of this hazard is the opposite one — an ObjectId
     * column ported to `text` turns a loud CastError into a silent non-match.
     * It does not apply here because BOTH sides of every comparison are the
     * same unconverted string.
     */
    oxyUserId: text().notNull(),
    type: text().notNull(),
    rating: integer(),
    message: text().notNull(),
    email: text(),

    /**
     * The `metadata` sub-document as three columns rather than `jsonb`.
     *
     * The Mongoose schema declares exactly these three keys, so strict mode
     * STRIPS anything else — and `routes/feedback.ts:41` passes `metadata`
     * straight out of the request body. A `jsonb` column would start STORING
     * arbitrary unvalidated user input that the source silently discarded,
     * which is a behaviour change disguised as fidelity.
     */
    metadataPlatform: text(),
    metadataAppVersion: text(),
    metadataDeviceInfo: text(),

    status: text().notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('feedback_user_created_idx').on(t.oxyUserId, t.createdAt.desc()),
    index('feedback_status_idx').on(t.status),
    index('feedback_type_idx').on(t.type),

    check('feedback_type', sql`${t.type} in (${sql.raw(inList(FEEDBACK_TYPES))})`),
    check('feedback_status', sql`${t.status} in (${sql.raw(inList(FEEDBACK_STATUSES))})`),
    /**
     * `min: 1, max: 5` genuinely fires: feedback is written by
     * `new Feedback(...).save()` (`routes/feedback.ts:35-45`), the one path
     * that runs validators. Nullable, so the CHECK admits NULL explicitly.
     */
    check('feedback_rating_range', sql`${t.rating} is null or (${t.rating} >= 1 and ${t.rating} <= 5)`),
  ],
);
