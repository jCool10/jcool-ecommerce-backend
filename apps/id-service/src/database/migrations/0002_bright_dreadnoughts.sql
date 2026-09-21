-- The node field narrowed from 10 bits to 5, so the pool narrows with it. The DELETE has to come
-- first: the rows seeded above 30 would fail the new CHECK. A replica still holding one of them
-- finds 0 rows on its next renew, gives the lease up and stops minting — the path the lease already
-- takes for an expired holder.
DELETE FROM "node_leases" WHERE "node_id" > 30;--> statement-breakpoint
ALTER TABLE "node_leases" DROP CONSTRAINT "node_leases_node_id_range";--> statement-breakpoint
ALTER TABLE "node_leases" ADD CONSTRAINT "node_leases_node_id_range" CHECK ("node_leases"."node_id" BETWEEN 1 AND 30);
