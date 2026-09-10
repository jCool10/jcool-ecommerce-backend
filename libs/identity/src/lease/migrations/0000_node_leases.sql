-- No seed rows: pools are per service and acquire materializes its own on first contact, so this
-- migration cannot know which services will exist — and a truncate can never wipe a seed that
-- nothing depends on.
--
-- A node is reclaimable only when BOTH the lease has expired and last_ts_ms is far enough in the
-- past, each with the SAME clock-skew allowance (IDENTITY_LEASE_SKEW_MS, default 5s). The allowance
-- on renewed_at is not redundant: a holder keeps minting after its last successful renewal, so under
-- a partition the reclaimer's view of last_ts_ms is up to one renewal interval stale and would pass
-- on old data. Raise the skew if hosts are not NTP-synced; lowering it silently reintroduces the
-- overlapping-holder bug this table exists to prevent.
CREATE TABLE "node_leases" (
	"service" text NOT NULL,
	"node" smallint NOT NULL,
	"lease_id" uuid,
	"holder" text,
	"renewed_at" timestamp with time zone,
	"last_ts_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "node_leases_service_node_pk" PRIMARY KEY("service","node"),
	CONSTRAINT "ck_node_leases_range" CHECK ("node_leases"."node" BETWEEN 0 AND 1022)
);
