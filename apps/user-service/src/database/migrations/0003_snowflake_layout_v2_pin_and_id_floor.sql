-- Layout 2 ships as a reset. A layout-1 id still passes the new floor but decodes into other fields,
-- and a database holding users is never pinned, so the layout pin would not notice the two mixing.
DO $$
DECLARE
  t text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'refresh_tokens', 'password_reset_tokens', 'email_verification_tokens', 'identity_key_pin'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', t) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'id layout 2 needs a reset database: table % is not empty', t;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP CONSTRAINT "ck_email_verification_tokens_id_routable";--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP CONSTRAINT "ck_email_verification_tokens_user_id_routable";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "ck_password_reset_tokens_id_routable";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "ck_password_reset_tokens_user_id_routable";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "ck_refresh_tokens_id_routable";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "ck_refresh_tokens_user_id_routable";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "ck_refresh_tokens_replaced_by_token_id_routable";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "ck_refresh_tokens_family_id_routable";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "ck_users_id_routable";--> statement-breakpoint
ALTER TABLE "identity_key_pin" DROP COLUMN "fingerprint";--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "ck_email_verification_tokens_id_routable" CHECK ("email_verification_tokens"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "ck_email_verification_tokens_user_id_routable" CHECK ("email_verification_tokens"."user_id" >= 262144);--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "ck_password_reset_tokens_id_routable" CHECK ("password_reset_tokens"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "ck_password_reset_tokens_user_id_routable" CHECK ("password_reset_tokens"."user_id" >= 262144);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_id_routable" CHECK ("refresh_tokens"."id" >= 262144);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_user_id_routable" CHECK ("refresh_tokens"."user_id" >= 262144);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_replaced_by_token_id_routable" CHECK ("refresh_tokens"."replaced_by_token_id" >= 262144);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "ck_refresh_tokens_family_id_routable" CHECK ("refresh_tokens"."family_id" >= 262144);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_id_routable" CHECK ("users"."id" >= 262144);