ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "ck_email_verification_tokens_id_routable" CHECK ("email_verification_tokens"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "ck_email_verification_tokens_user_id_routable" CHECK ("email_verification_tokens"."user_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "ck_password_reset_tokens_id_routable" CHECK ("password_reset_tokens"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "ck_password_reset_tokens_user_id_routable" CHECK ("password_reset_tokens"."user_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_id_routable" CHECK ("refresh_tokens"."id" >= 4194304);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_user_id_routable" CHECK ("refresh_tokens"."user_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_replaced_by_token_id_routable" CHECK ("refresh_tokens"."replaced_by_token_id" >= 4194304);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_id_routable" CHECK ("users"."id" >= 4194304);