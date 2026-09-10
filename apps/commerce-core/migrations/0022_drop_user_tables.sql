-- Ships only after the rows are verified in the user service's database (RUNBOOK: "Split the user
-- service off"). Until then commerce-core keeps the tables it no longer reads, which is what makes
-- the cutover reversible. `orders.user_id` has never had a foreign key to `users`, so nothing here
-- cascades into commerce data.
DROP TABLE "email_verification_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "identity_key_pin" CASCADE;--> statement-breakpoint
DROP TABLE "password_reset_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "refresh_tokens" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
DROP TYPE "public"."role";
