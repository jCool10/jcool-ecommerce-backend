CREATE INDEX "idx_email_verification_tokens_expires" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_email_verification_tokens_consumed" ON "email_verification_tokens" USING btree ("consumed_at") WHERE "email_verification_tokens"."consumed_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_expires" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_password_reset_tokens_consumed" ON "password_reset_tokens" USING btree ("consumed_at") WHERE "password_reset_tokens"."consumed_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_expires" ON "refresh_tokens" USING btree ("expires_at") WHERE "refresh_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_revoked" ON "refresh_tokens" USING btree ("revoked_at") WHERE "refresh_tokens"."revoked_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_webhook_events_received" ON "webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_published" ON "outbox" USING btree ("published_at") WHERE "outbox"."published_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_inbox_processed" ON "inbox" USING btree ("processed_at");