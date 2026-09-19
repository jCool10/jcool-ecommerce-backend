-- The whole pool up front: acquire only ever claims existing rows, so a missing row is a node that
-- can never be leased. Bounds match the table's CHECK constraint.
INSERT INTO "node_leases" ("node_id") SELECT generate_series(1, 1022);
