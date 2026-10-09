CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"file_id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"type" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"ai_file_id" text,
	"error_message" text,
	"original_path" text NOT NULL,
	"processed_path" text,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	CONSTRAINT "files_type_check" CHECK ("files"."type" IN ('pdf','docx','image')),
	CONSTRAINT "files_status_check" CHECK ("files"."status" IN ('uploaded','parsing','parsed','converted','failed'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "files_created_at_idx" ON "files" USING btree ("created_at","file_id");--> statement-breakpoint
CREATE INDEX "files_parsing_idx" ON "files" USING btree ("updated_at") WHERE "files"."status" = 'parsing';--> statement-breakpoint
CREATE INDEX "files_dedup_idx" ON "files" USING btree ("sha256","filename") WHERE "files"."sha256" IS NOT NULL AND "files"."status" <> 'failed';