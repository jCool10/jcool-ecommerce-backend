-- A uuid has no bigint form, so every session ends here and each user signs in again.
DELETE FROM "refresh_tokens";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "family_id" SET DATA TYPE bigint USING NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_family_id_routable" CHECK ("refresh_tokens"."family_id" >= 4194304);
