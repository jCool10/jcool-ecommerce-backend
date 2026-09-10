CREATE TABLE "identity_key_pin" (
	"id" smallint PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_identity_key_pin_singleton" CHECK ("identity_key_pin"."id" = 1)
);
