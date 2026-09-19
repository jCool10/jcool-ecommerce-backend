CREATE TABLE "node_leases" (
	"node_id" smallint PRIMARY KEY NOT NULL,
	"holder" text,
	"generation" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone DEFAULT 'epoch' NOT NULL,
	"max_ts_ms" bigint,
	"acquired_at" timestamp with time zone,
	"renewed_at" timestamp with time zone,
	CONSTRAINT "node_leases_node_id_range" CHECK ("node_leases"."node_id" BETWEEN 1 AND 1022)
);
