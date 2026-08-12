-- oxy:deploy-phase=pre
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "workspace_members_role" CHECK ("workspace_members"."role" in ('viewer', 'commenter', 'editor', 'admin', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"owner_id" text NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "workspaces_name_length" CHECK (char_length("workspaces"."name") <= 200)
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_key" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_joined_idx" ON "workspace_members" USING btree ("user_id","joined_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workspaces_owner_personal_idx" ON "workspaces" USING btree ("owner_id","is_personal");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_personal_workspace_per_owner" ON "workspaces" USING btree ("owner_id") WHERE "workspaces"."is_personal";
