-- oxy:deploy-phase=pre
CREATE TABLE "chat_analytics" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text,
	"model" text NOT NULL,
	"clarity_model_id" text,
	"provider" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"platform" text DEFAULT 'app' NOT NULL,
	"skill_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "chat_analytics_non_negative" CHECK ("chat_analytics"."prompt_tokens" >= 0 and "chat_analytics"."completion_tokens" >= 0 and "chat_analytics"."total_tokens" >= 0 and "chat_analytics"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "chat_analytics_user_created_idx" ON "chat_analytics" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);
