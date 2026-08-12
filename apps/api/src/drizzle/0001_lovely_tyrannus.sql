-- oxy:deploy-phase=pre
CREATE TABLE "blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"parent_block_id" text,
	"type" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "blocks_type" CHECK ("blocks"."type" in ('paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'todo', 'quote', 'divider', 'code', 'callout', 'toggle', 'image', 'video', 'audio', 'file', 'pdf', 'bookmark', 'embed', 'columns', 'column', 'table', 'table_row', 'table_cell', 'button', 'link_to_page', 'sync_block', 'breadcrumb', 'table_of_contents', 'equation', 'mermaid', 'inline_database'))
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_id" text,
	"title" text DEFAULT '' NOT NULL,
	"icon" text,
	"cover" text,
	"cover_position" double precision DEFAULT 50 NOT NULL,
	"owner_id" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"favorited" boolean DEFAULT false NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"database_id" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "pages_cover_position_range" CHECK ("pages"."cover_position" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "database_views" (
	"id" text PRIMARY KEY NOT NULL,
	"database_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'table' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"filters" jsonb DEFAULT '{"kind":"group","combinator":"and","filters":[]}'::jsonb NOT NULL,
	"sorts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_by" jsonb,
	"hidden_properties" text[] DEFAULT '{}' NOT NULL,
	"frozen_properties" text[] DEFAULT '{}' NOT NULL,
	"page_size" integer DEFAULT 50 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "database_views_type" CHECK ("database_views"."type" in ('table', 'board', 'gallery', 'list', 'calendar', 'timeline')),
	CONSTRAINT "database_views_sorts_shape" CHECK (jsonb_typeof("database_views"."sorts") = 'array'
        and not jsonb_path_exists("database_views"."sorts", '$[*] ? (!(@.propertyId.type() == "string" && @.propertyId <> "" && exists(@.direction)))')
        and not jsonb_path_exists("database_views"."sorts", '$[*].direction ? (!(@ == "asc" || @ == "desc"))'))
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"icon" text,
	"cover" text,
	"owner_id" text NOT NULL,
	"properties_schema" jsonb DEFAULT '{"properties":[]}'::jsonb NOT NULL,
	"is_inline" boolean DEFAULT false NOT NULL,
	"parent_page_id" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "databases_property_types" CHECK (not jsonb_path_exists("databases"."properties_schema", '$.properties[*].type ? (!(@ == "text" || @ == "number" || @ == "select" || @ == "multi_select" || @ == "status" || @ == "date" || @ == "person" || @ == "files" || @ == "checkbox" || @ == "url" || @ == "email" || @ == "phone" || @ == "relation" || @ == "rollup" || @ == "created_time" || @ == "last_edited_time" || @ == "created_by" || @ == "last_edited_by" || @ == "formula"))')),
	CONSTRAINT "databases_properties_schema_shape" CHECK (jsonb_typeof(coalesce("databases"."properties_schema" -> 'properties', 'null'::jsonb)) = 'array'
        and not jsonb_path_exists("databases"."properties_schema", '$.properties[*] ? (!(@.id.type() == "string" && @.id <> "" && @.name.type() == "string" && @.name <> "" && exists(@.type)))'))
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"page_id" text NOT NULL,
	"block_id" text,
	"parent_comment_id" text,
	"author_id" text NOT NULL,
	"content_segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_plain_text" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "comments_segments_is_array" CHECK (jsonb_typeof("comments"."content_segments") = 'array')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"delivery_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"trigger_id" text,
	"conversation_id" text,
	"expires_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"dismissed_reap_at" timestamp with time zone GENERATED ALWAYS AS (case when "notifications"."status" = 'dismissed' then "notifications"."created_at" end) STORED,
	CONSTRAINT "notifications_type" CHECK ("notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service', 'mention', 'comment_reply')),
	CONSTRAINT "notifications_status" CHECK ("notifications"."status" in ('pending', 'sent', 'read', 'dismissed')),
	CONSTRAINT "notifications_priority" CHECK ("notifications"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "notifications_channels" CHECK ("notifications"."channels" <@ array['push', 'telegram', 'discord', 'whatsapp', 'slack', 'in_app']::text[]),
	CONSTRAINT "notifications_delivery_status_is_object" CHECK (jsonb_typeof("notifications"."delivery_status") = 'object')
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"token" text NOT NULL,
	"device_id" text,
	"platform" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "push_tokens_platform" CHECK ("push_tokens"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"token" text NOT NULL,
	"scope" text DEFAULT 'read' NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "share_links_scope" CHECK ("share_links"."scope" in ('read', 'comment', 'edit'))
);
--> statement-breakpoint
CREATE TABLE "web_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"key_p_256dh" text NOT NULL,
	"key_auth" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text,
	"oxy_user_id" text NOT NULL,
	"app_id" text,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"response_time" integer,
	"user_agent" text,
	"ip_address" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"auth_type" text DEFAULT 'api_key' NOT NULL,
	"service_app" text,
	CONSTRAINT "api_key_usage_method" CHECK ("api_key_usage"."method" in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "api_key_usage_auth_type" CHECK ("api_key_usage"."auth_type" in ('api_key', 'session', 'internal'))
);
--> statement-breakpoint
CREATE TABLE "developer_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{"chat:read","chat:write"}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"rate_limit_requests_per_minute" integer,
	"rate_limit_requests_per_day" integer DEFAULT 1000,
	"rate_limit_tokens_per_minute" integer,
	"rate_limit_tokens_per_day" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "developer_api_keys_name_length" CHECK (char_length("developer_api_keys"."name") <= 100),
	CONSTRAINT "developer_api_keys_scopes" CHECK ("developer_api_keys"."scopes" <@ array['chat:read', 'chat:write', 'models:read', 'conversations:read', 'conversations:write', 'conversations:delete', 'memory:read', 'memory:write']::text[])
);
--> statement-breakpoint
CREATE TABLE "developer_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"description" text,
	"website_url" text,
	"redirect_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"icon" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "developer_apps_name_length" CHECK (char_length("developer_apps"."name") <= 100),
	CONSTRAINT "developer_apps_description_length" CHECK ("developer_apps"."description" is null or char_length("developer_apps"."description") <= 500)
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"rating" integer,
	"message" text NOT NULL,
	"email" text,
	"metadata_platform" text,
	"metadata_app_version" text,
	"metadata_device_info" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feedback_type" CHECK ("feedback"."type" in ('bug', 'feature', 'improvement', 'other')),
	CONSTRAINT "feedback_status" CHECK ("feedback"."status" in ('pending', 'reviewed', 'resolved')),
	CONSTRAINT "feedback_rating_range" CHECK ("feedback"."rating" is null or ("feedback"."rating" >= 1 and "feedback"."rating" <= 5))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"plan_id" text,
	"billing_period" text DEFAULT 'monthly' NOT NULL,
	"plan_plan_id" text,
	"plan_name" text,
	"plan_product" text DEFAULT 'clarity',
	"plan_credits_per_month" integer,
	"plan_price" integer,
	"plan_currency" text DEFAULT 'usd',
	"plan_billing_period" text DEFAULT 'monthly',
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "subscriptions_status" CHECK ("subscriptions"."status" in ('active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete', 'incomplete_expired', 'paused')),
	CONSTRAINT "subscriptions_billing_period" CHECK ("subscriptions"."billing_period" in ('monthly', 'annual')),
	CONSTRAINT "subscriptions_plan_product" CHECK ("subscriptions"."plan_product" is null or "subscriptions"."plan_product" in ('clarity', 'codea')),
	CONSTRAINT "subscriptions_plan_billing_period" CHECK ("subscriptions"."plan_billing_period" is null or "subscriptions"."plan_billing_period" in ('monthly', 'annual'))
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_intent_id" text,
	"type" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"credits" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"dedup" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "transactions_type" CHECK ("transactions"."type" in ('credit_purchase', 'subscription_payment', 'refund')),
	CONSTRAINT "transactions_status" CHECK ("transactions"."status" in ('pending', 'completed', 'failed', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "user_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"credits_free" integer DEFAULT 300 NOT NULL,
	"credits_free_limit" integer DEFAULT 300 NOT NULL,
	"credits_daily_refresh" integer DEFAULT 300 NOT NULL,
	"credits_paid" integer DEFAULT 0 NOT NULL,
	"credits_last_refresh" timestamp with time zone DEFAULT now() NOT NULL,
	"credits_last_used" timestamp with time zone,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_credits_non_negative" CHECK ("user_credits"."credits_free" >= 0 and "user_credits"."credits_paid" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"is_manual_title" boolean DEFAULT false NOT NULL,
	"last_message" text,
	"source" text DEFAULT 'app' NOT NULL,
	"folder_id" text,
	"icon" text,
	"icon_color" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversations_source" CHECK ("conversations"."source" in ('app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"message_id" text,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"vote" text,
	"tool_invocations" jsonb,
	"agent_info" jsonb,
	"audio_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "messages_role" CHECK ("messages"."role" in ('user', 'assistant', 'system')),
	CONSTRAINT "messages_vote" CHECK ("messages"."vote" in ('up', 'down'))
);
--> statement-breakpoint
CREATE TABLE "api_usages" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_health_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"successes" bigint DEFAULT 0 NOT NULL,
	"failures" bigint DEFAULT 0 NOT NULL,
	"last_failure" timestamp with time zone,
	"last_failure_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarity_model_provider_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"clarity_model_id" text NOT NULL,
	"model_config_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"priority" double precision NOT NULL,
	"quality_score" double precision NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "clarity_model_provider_mappings_priority" CHECK ("clarity_model_provider_mappings"."priority" between 1 and 100),
	CONSTRAINT "clarity_model_provider_mappings_quality_score" CHECK ("clarity_model_provider_mappings"."quality_score" between 0 and 100),
	CONSTRAINT "clarity_model_provider_mappings_position" CHECK ("clarity_model_provider_mappings"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "clarity_models" (
	"id" text PRIMARY KEY NOT NULL,
	"clarity_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"tier" text NOT NULL,
	"description" text,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"credit_multiplier" double precision DEFAULT 1 NOT NULL,
	"is_free_tier" boolean DEFAULT true NOT NULL,
	"cap_vision" boolean DEFAULT false NOT NULL,
	"cap_audio" boolean DEFAULT false NOT NULL,
	"cap_code_execution" boolean DEFAULT false NOT NULL,
	"cap_web_search" boolean DEFAULT false NOT NULL,
	"cap_thinking" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_deprecated" boolean DEFAULT false NOT NULL,
	"is_legacy" boolean DEFAULT false NOT NULL,
	"deprecation_date" timestamp with time zone,
	"replacement_model_id" text,
	"total_requests" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"average_latency_ms" double precision DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "clarity_models_clarity_model_id_key" UNIQUE("clarity_model_id"),
	CONSTRAINT "clarity_models_clarity_model_id_lower" CHECK ("clarity_models"."clarity_model_id" = lower("clarity_models"."clarity_model_id")),
	CONSTRAINT "clarity_models_tier" CHECK ("clarity_models"."tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro')),
	CONSTRAINT "clarity_models_credit_multiplier" CHECK ("clarity_models"."credit_multiplier" between 0.1 and 10),
	CONSTRAINT "clarity_models_description_length" CHECK (char_length("clarity_models"."description") <= 1000),
	CONSTRAINT "clarity_models_notes_length" CHECK (char_length("clarity_models"."notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"clarity_model_id" text NOT NULL,
	"actual_provider" text NOT NULL,
	"actual_model_id" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"total_tokens" bigint NOT NULL,
	"cost_usd" double precision NOT NULL,
	"saved_from_cache" boolean DEFAULT false NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"name" text NOT NULL,
	"credits" double precision NOT NULL,
	"price" double precision NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"stripe_price_id" text,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "credit_packages_package_id_key" UNIQUE("package_id"),
	CONSTRAINT "credit_packages_package_id_lower" CHECK ("credit_packages"."package_id" = lower("credit_packages"."package_id")),
	CONSTRAINT "credit_packages_credits" CHECK ("credit_packages"."credits" >= 1),
	CONSTRAINT "credit_packages_price" CHECK ("credit_packages"."price" >= 0),
	CONSTRAINT "credit_packages_description_length" CHECK (char_length("credit_packages"."description") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "fallback_event_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"position" integer NOT NULL,
	"provider" text,
	"model" text,
	"error" text,
	"reason" text,
	"latency_ms" double precision,
	CONSTRAINT "fallback_event_attempts_position" CHECK ("fallback_event_attempts"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fallback_events" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"clarity_model" text NOT NULL,
	"final_provider" text,
	"final_model" text,
	"success" boolean NOT NULL,
	"total_latency_ms" double precision
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" text PRIMARY KEY NOT NULL,
	"feature_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"icon" text,
	"category" text NOT NULL,
	"feature_type" text DEFAULT 'boolean' NOT NULL,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"is_visible_on_pricing" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "features_feature_id_key" UNIQUE("feature_id"),
	CONSTRAINT "features_feature_id_lower" CHECK ("features"."feature_id" = lower("features"."feature_id")),
	CONSTRAINT "features_feature_type" CHECK ("features"."feature_type" in ('boolean', 'limit'))
);
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"clarity_tier" text,
	"priority" double precision,
	"quality_score" double precision,
	"cap_vision" boolean DEFAULT false NOT NULL,
	"cap_audio" boolean DEFAULT false NOT NULL,
	"cap_code_execution" boolean DEFAULT false NOT NULL,
	"cap_web_search" boolean DEFAULT false NOT NULL,
	"cap_computer_use" boolean DEFAULT false NOT NULL,
	"cap_thinking" boolean DEFAULT false NOT NULL,
	"cap_streaming" boolean DEFAULT true NOT NULL,
	"cap_function_calling" boolean DEFAULT true NOT NULL,
	"cap_json_mode" boolean DEFAULT false NOT NULL,
	"cap_prompt_caching" boolean DEFAULT false NOT NULL,
	"limit_max_context_tokens" double precision NOT NULL,
	"limit_max_output_tokens" double precision NOT NULL,
	"limit_max_images" double precision,
	"limit_max_audio_seconds" double precision,
	"pricing_tier" text NOT NULL,
	"pricing_cost_per1_m_input" double precision NOT NULL,
	"pricing_cost_per1_m_output" double precision NOT NULL,
	"pricing_cost_per1_m_cached_input" double precision,
	"pricing_average_latency_ms" double precision NOT NULL,
	"default_temperature" double precision,
	"default_top_p" double precision,
	"default_max_tokens" double precision,
	"default_system_prompt" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_deprecated" boolean DEFAULT false NOT NULL,
	"deprecation_date" timestamp with time zone,
	"replacement_model_id" text,
	"description" text,
	"provider_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "model_configs_provider" CHECK ("model_configs"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean')),
	CONSTRAINT "model_configs_clarity_tier" CHECK ("model_configs"."clarity_tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro')),
	CONSTRAINT "model_configs_pricing_tier" CHECK ("model_configs"."pricing_tier" in ('free', 'freemium', 'paid')),
	CONSTRAINT "model_configs_priority" CHECK ("model_configs"."priority" between 1 and 100),
	CONSTRAINT "model_configs_quality_score" CHECK ("model_configs"."quality_score" between 0 and 100),
	CONSTRAINT "model_configs_description_length" CHECK (char_length("model_configs"."description") <= 1000),
	CONSTRAINT "model_configs_provider_url_length" CHECK (char_length("model_configs"."provider_url") <= 500),
	CONSTRAINT "model_configs_notes_length" CHECK (char_length("model_configs"."notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "plan_features" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_value" double precision,
	"display_label" text,
	"display_description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"name" text NOT NULL,
	"product" text NOT NULL,
	"credits_per_month" double precision DEFAULT 0 NOT NULL,
	"daily_free_credits" double precision DEFAULT 300 NOT NULL,
	"monthly_price" double precision DEFAULT 0 NOT NULL,
	"annual_price" double precision DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"credits_label" text DEFAULT '' NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"model_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"stripe_product_id" text,
	"stripe_monthly_price_id" text,
	"stripe_annual_price_id" text,
	"description" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "plans_plan_id_key" UNIQUE("plan_id"),
	CONSTRAINT "plans_plan_id_lower" CHECK ("plans"."plan_id" = lower("plans"."plan_id")),
	CONSTRAINT "plans_product" CHECK ("plans"."product" in ('clarity', 'codea')),
	CONSTRAINT "plans_description_length" CHECK (char_length("plans"."description") <= 1000),
	CONSTRAINT "plans_notes_length" CHECK (char_length("plans"."notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "provider_healths" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"success_count" bigint DEFAULT 0 NOT NULL,
	"failure_count" bigint DEFAULT 0 NOT NULL,
	"total_requests" bigint DEFAULT 0 NOT NULL,
	"success_rate" double precision DEFAULT 100 NOT NULL,
	"average_latency_ms" double precision DEFAULT 0 NOT NULL,
	"latency_samples" double precision[] DEFAULT '{}'::double precision[] NOT NULL,
	"last_success" timestamp with time zone,
	"last_failure" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"circuit_opened_at" timestamp with time zone,
	"half_open_attempts" integer DEFAULT 0 NOT NULL,
	"last_health_check" timestamp with time zone DEFAULT now() NOT NULL,
	"is_healthy" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "provider_healths_circuit_state" CHECK ("provider_healths"."circuit_state" in ('closed', 'open', 'half-open'))
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key" text,
	"rate_limit_rps" double precision,
	"rate_limit_rpm" double precision,
	"rate_limit_rph" double precision,
	"rate_limit_rpd" double precision,
	"rate_limit_tps" double precision,
	"rate_limit_tpm" double precision,
	"rate_limit_tph" double precision,
	"rate_limit_tpd" double precision,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_paid" boolean DEFAULT false NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"current_priority" double precision DEFAULT 10 NOT NULL,
	"original_priority" double precision DEFAULT 10 NOT NULL,
	"credit_limit_usd" double precision,
	"spent_usd" double precision DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"total_requests" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"success_count" bigint DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"total_failures" bigint DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"cooldown_until" timestamp with time zone,
	"rate_limit_reset_ms" double precision,
	"max_total_failures" double precision DEFAULT 100 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rotation_schedule" text DEFAULT 'manual' NOT NULL,
	"owner_id" text,
	"organization_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "provider_keys_provider" CHECK ("provider_keys"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean')),
	CONSTRAINT "provider_keys_environment" CHECK ("provider_keys"."environment" in ('production', 'staging', 'development')),
	CONSTRAINT "provider_keys_tier" CHECK ("provider_keys"."tier" in ('free', 'freemium', 'paid', 'enterprise')),
	CONSTRAINT "provider_keys_rotation_schedule" CHECK ("provider_keys"."rotation_schedule" in ('manual', 'monthly', 'quarterly', 'yearly')),
	CONSTRAINT "provider_keys_name_length" CHECK (char_length("provider_keys"."name") <= 200),
	CONSTRAINT "provider_keys_key_prefix_length" CHECK (char_length("provider_keys"."key_prefix") <= 20),
	CONSTRAINT "provider_keys_last_failure_reason_length" CHECK (char_length("provider_keys"."last_failure_reason") <= 500),
	CONSTRAINT "provider_keys_archived_reason_length" CHECK (char_length("provider_keys"."archived_reason") <= 500),
	CONSTRAINT "provider_keys_spent_usd" CHECK ("provider_keys"."spent_usd" >= 0),
	CONSTRAINT "provider_keys_current_priority" CHECK ("provider_keys"."current_priority" between 1 and 1000),
	CONSTRAINT "provider_keys_original_priority" CHECK ("provider_keys"."original_priority" between 1 and 100),
	CONSTRAINT "provider_keys_max_total_failures" CHECK ("provider_keys"."max_total_failures" between 10 and 1000)
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_parent_block_id_blocks_id_fk" FOREIGN KEY ("parent_block_id") REFERENCES "public"."blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_views" ADD CONSTRAINT "database_views_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_api_keys" ADD CONSTRAINT "developer_api_keys_app_id_developer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."developer_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usages" ADD CONSTRAINT "api_usages_key_id_provider_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."provider_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_model_provider_mappings" ADD CONSTRAINT "clarity_model_provider_mappings_clarity_model_id_clarity_models_id_fk" FOREIGN KEY ("clarity_model_id") REFERENCES "public"."clarity_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarity_model_provider_mappings" ADD CONSTRAINT "clarity_model_provider_mappings_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fallback_event_attempts" ADD CONSTRAINT "fallback_event_attempts_event_id_fallback_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."fallback_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_page_parent_order_idx" ON "blocks" USING btree ("page_id","parent_block_id","order");--> statement-breakpoint
CREATE INDEX "blocks_parent_block_idx" ON "blocks" USING btree ("parent_block_id");--> statement-breakpoint
CREATE INDEX "pages_workspace_parent_order_idx" ON "pages" USING btree ("workspace_id","parent_id","order");--> statement-breakpoint
CREATE INDEX "pages_workspace_archived_idx" ON "pages" USING btree ("workspace_id","archived");--> statement-breakpoint
CREATE INDEX "pages_database_archived_created_idx" ON "pages" USING btree ("database_id","archived","created_at");--> statement-breakpoint
CREATE INDEX "pages_parent_idx" ON "pages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "pages_workspace_favorited_idx" ON "pages" USING btree ("workspace_id") WHERE "pages"."favorited";--> statement-breakpoint
CREATE INDEX "pages_properties_gin_idx" ON "pages" USING gin ("properties");--> statement-breakpoint
CREATE INDEX "database_views_database_order_idx" ON "database_views" USING btree ("database_id","order","created_at");--> statement-breakpoint
CREATE INDEX "databases_workspace_archived_updated_idx" ON "databases" USING btree ("workspace_id","archived","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "databases_parent_page_idx" ON "databases" USING btree ("parent_page_id");--> statement-breakpoint
CREATE INDEX "comments_page_resolved_created_idx" ON "comments" USING btree ("page_id","resolved_at","created_at");--> statement-breakpoint
CREATE INDEX "comments_block_resolved_created_idx" ON "comments" USING btree ("block_id","resolved_at","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_created_idx" ON "comments" USING btree ("parent_comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_workspace_idx" ON "comments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "notifications_user_status_created_idx" ON "notifications" USING btree ("oxy_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("oxy_user_id","status") WHERE "notifications"."status" in ('pending', 'sent');--> statement-breakpoint
CREATE INDEX "notifications_dismissed_reap_idx" ON "notifications" USING btree ("dismissed_reap_at") WHERE "notifications"."dismissed_reap_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_user_token_key" ON "push_tokens" USING btree ("oxy_user_id","token");--> statement-breakpoint
CREATE INDEX "push_tokens_token_idx" ON "push_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_key" ON "share_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "share_links_page_revoked_created_idx" ON "share_links" USING btree ("page_id","revoked_at","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "web_push_subscriptions_user_endpoint_key" ON "web_push_subscriptions" USING btree ("oxy_user_id","endpoint");--> statement-breakpoint
CREATE INDEX "api_key_usage_key_timestamp_idx" ON "api_key_usage" USING btree ("api_key_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_user_timestamp_idx" ON "api_key_usage" USING btree ("oxy_user_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_user_auth_timestamp_idx" ON "api_key_usage" USING btree ("oxy_user_id","auth_type","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_app_timestamp_idx" ON "api_key_usage" USING btree ("app_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_timestamp_idx" ON "api_key_usage" USING btree ("timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "developer_api_keys_key_hash_key" ON "developer_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "developer_api_keys_user_active_idx" ON "developer_api_keys" USING btree ("oxy_user_id","is_active");--> statement-breakpoint
CREATE INDEX "developer_api_keys_app_active_idx" ON "developer_api_keys" USING btree ("app_id","is_active");--> statement-breakpoint
CREATE INDEX "developer_apps_user_idx" ON "developer_apps" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "developer_apps_org_idx" ON "developer_apps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "developer_apps_user_active_idx" ON "developer_apps" USING btree ("oxy_user_id","is_active");--> statement-breakpoint
CREATE INDEX "feedback_user_created_idx" ON "feedback" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "feedback" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feedback_type_idx" ON "feedback" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_status_idx" ON "subscriptions" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_user_product_status_idx" ON "subscriptions" USING btree ("oxy_user_id","plan_product","status");--> statement-breakpoint
CREATE INDEX "subscriptions_stripe_customer_idx" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_plan_idx" ON "subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_created_idx" ON "subscriptions" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_stripe_payment_intent_key" ON "transactions" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_dedup_key" ON "transactions" USING btree ("dedup");--> statement-breakpoint
CREATE INDEX "transactions_user_created_idx" ON "transactions" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_credits_stripe_customer_idx" ON "user_credits" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_user_conversation_key" ON "conversations" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_user_updated_idx" ON "conversations" USING btree ("oxy_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_user_agent_idx" ON "conversations" USING btree ("oxy_user_id","agent_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_user_conversation_idx" ON "messages" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "api_usages_key_timestamp_idx" ON "api_usages" USING btree ("key_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_usages_provider_idx" ON "api_usages" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "api_usages_timestamp_idx" ON "api_usages" USING btree ("timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_health_metrics_method_hour_key" ON "auth_health_metrics" USING btree ("method","hour");--> statement-breakpoint
CREATE INDEX "auth_health_metrics_hour_idx" ON "auth_health_metrics" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "auth_health_metrics_created_at_idx" ON "auth_health_metrics" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clarity_model_provider_mappings_model_position_key" ON "clarity_model_provider_mappings" USING btree ("clarity_model_id","position");--> statement-breakpoint
CREATE INDEX "clarity_model_provider_mappings_model_active_priority_idx" ON "clarity_model_provider_mappings" USING btree ("clarity_model_id","is_active","priority");--> statement-breakpoint
CREATE INDEX "clarity_model_provider_mappings_model_config_idx" ON "clarity_model_provider_mappings" USING btree ("model_config_id");--> statement-breakpoint
CREATE INDEX "clarity_models_tier_active_idx" ON "clarity_models" USING btree ("tier","is_active");--> statement-breakpoint
CREATE INDEX "clarity_models_active_deprecated_idx" ON "clarity_models" USING btree ("is_active","is_deprecated");--> statement-breakpoint
CREATE INDEX "cost_entries_user_timestamp_idx" ON "cost_entries" USING btree ("user_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_entries_clarity_model_timestamp_idx" ON "cost_entries" USING btree ("clarity_model_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cost_entries_user_clarity_model_idx" ON "cost_entries" USING btree ("user_id","clarity_model_id");--> statement-breakpoint
CREATE INDEX "cost_entries_session_idx" ON "cost_entries" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "cost_entries_timestamp_idx" ON "cost_entries" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "credit_packages_active_sort_idx" ON "credit_packages" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "fallback_event_attempts_event_position_key" ON "fallback_event_attempts" USING btree ("event_id","position");--> statement-breakpoint
CREATE INDEX "fallback_event_attempts_reason_idx" ON "fallback_event_attempts" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "fallback_event_attempts_provider_idx" ON "fallback_event_attempts" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "fallback_events_clarity_model_timestamp_idx" ON "fallback_events" USING btree ("clarity_model","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fallback_events_success_timestamp_idx" ON "fallback_events" USING btree ("success","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fallback_events_timestamp_idx" ON "fallback_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "features_category_sort_idx" ON "features" USING btree ("category","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "model_configs_provider_model_key" ON "model_configs" USING btree ("provider","model_id");--> statement-breakpoint
CREATE INDEX "model_configs_clarity_tier_priority_idx" ON "model_configs" USING btree ("clarity_tier","priority");--> statement-breakpoint
CREATE INDEX "model_configs_active_deprecated_idx" ON "model_configs" USING btree ("is_active","is_deprecated");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_features_plan_feature_key" ON "plan_features" USING btree ("plan_id","feature_id");--> statement-breakpoint
CREATE INDEX "plan_features_feature_idx" ON "plan_features" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "plans_product_sort_idx" ON "plans" USING btree ("product","sort_order");--> statement-breakpoint
CREATE INDEX "plans_product_active_idx" ON "plans" USING btree ("product","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_healths_provider_model_key" ON "provider_healths" USING btree ("provider","model_id");--> statement-breakpoint
CREATE INDEX "provider_healths_circuit_state_idx" ON "provider_healths" USING btree ("circuit_state");--> statement-breakpoint
CREATE INDEX "provider_healths_updated_at_idx" ON "provider_healths" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_keys_key_hash_key" ON "provider_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "provider_keys_provider_active_archived_priority_idx" ON "provider_keys" USING btree ("provider","is_active","is_archived","current_priority");--> statement-breakpoint
CREATE INDEX "provider_keys_environment_active_idx" ON "provider_keys" USING btree ("environment","is_active");--> statement-breakpoint
CREATE INDEX "provider_keys_owner_idx" ON "provider_keys" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "provider_keys_organization_idx" ON "provider_keys" USING btree ("organization_id");
