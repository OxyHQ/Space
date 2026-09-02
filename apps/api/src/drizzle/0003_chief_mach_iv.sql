-- oxy:deploy-phase=post
ALTER TABLE "api_key_usage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "developer_api_keys" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "developer_apps" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_credits" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_usages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_health_metrics" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clarity_model_provider_mappings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clarity_models" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cost_entries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_packages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fallback_event_attempts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fallback_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "features" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_configs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_features" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plans" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_healths" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_keys" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_analytics" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "api_key_usage" CASCADE;--> statement-breakpoint
DROP TABLE "developer_api_keys" CASCADE;--> statement-breakpoint
DROP TABLE "developer_apps" CASCADE;--> statement-breakpoint
DROP TABLE "subscriptions" CASCADE;--> statement-breakpoint
DROP TABLE "transactions" CASCADE;--> statement-breakpoint
DROP TABLE "user_credits" CASCADE;--> statement-breakpoint
DROP TABLE "conversations" CASCADE;--> statement-breakpoint
DROP TABLE "messages" CASCADE;--> statement-breakpoint
DROP TABLE "api_usages" CASCADE;--> statement-breakpoint
DROP TABLE "auth_health_metrics" CASCADE;--> statement-breakpoint
DROP TABLE "clarity_model_provider_mappings" CASCADE;--> statement-breakpoint
DROP TABLE "clarity_models" CASCADE;--> statement-breakpoint
DROP TABLE "cost_entries" CASCADE;--> statement-breakpoint
DROP TABLE "credit_packages" CASCADE;--> statement-breakpoint
DROP TABLE "fallback_event_attempts" CASCADE;--> statement-breakpoint
DROP TABLE "fallback_events" CASCADE;--> statement-breakpoint
DROP TABLE "features" CASCADE;--> statement-breakpoint
DROP TABLE "model_configs" CASCADE;--> statement-breakpoint
DROP TABLE "plan_features" CASCADE;--> statement-breakpoint
DROP TABLE "plans" CASCADE;--> statement-breakpoint
DROP TABLE "provider_healths" CASCADE;--> statement-breakpoint
DROP TABLE "provider_keys" CASCADE;--> statement-breakpoint
DROP TABLE "chat_analytics" CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_channels";--> statement-breakpoint
DELETE FROM "notifications" WHERE "type" NOT IN ('mention', 'comment_reply');--> statement-breakpoint
UPDATE "notifications"
SET "channels" = ARRAY(
	SELECT channel
	FROM unnest("notifications"."channels") WITH ORDINALITY AS existing(channel, position)
	WHERE channel IN ('push', 'in_app')
	ORDER BY position
),
"delivery_status" = "delivery_status" - ARRAY['telegram', 'discord', 'whatsapp', 'slack']::text[]
WHERE NOT ("channels" <@ ARRAY['push', 'in_app']::text[])
	OR "delivery_status" ?| ARRAY['telegram', 'discord', 'whatsapp', 'slack']::text[];--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "conversation_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type" CHECK ("notifications"."type" in ('mention', 'comment_reply'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channels" CHECK ("notifications"."channels" <@ array['push', 'in_app']::text[]);
