-- The node field widened from 5 bits to 8, so the pool widens with it. The CHECK has to move first:
-- the rows seeded below would fail the old bound. Idempotent, so rows already present are left alone.
ALTER TABLE "node_leases" DROP CONSTRAINT "node_leases_node_id_range";--> statement-breakpoint
ALTER TABLE "node_leases" ADD CONSTRAINT "node_leases_node_id_range" CHECK ("node_leases"."node_id" BETWEEN 1 AND 254);--> statement-breakpoint
INSERT INTO "node_leases" ("node_id") SELECT generate_series(31, 254) ON CONFLICT DO NOTHING;
