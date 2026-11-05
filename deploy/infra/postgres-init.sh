#!/bin/sh
# Runs once, on an empty data directory. One role per service, owning only its own database; the
# passwords are hex, so they embed in SQL as they are. "order" is a keyword and is always quoted.
# Temporal creates temporal and temporal_visibility itself on boot, hence CREATEDB.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE jcool LOGIN PASSWORD '${API_DB_PASSWORD}';
CREATE DATABASE jcool_ecommerce OWNER jcool;
CREATE ROLE users LOGIN PASSWORD '${USERS_DB_PASSWORD}';
CREATE DATABASE users OWNER users;
CREATE ROLE inventory LOGIN PASSWORD '${INVENTORY_DB_PASSWORD}';
CREATE DATABASE inventory OWNER inventory;
CREATE ROLE payment LOGIN PASSWORD '${PAYMENT_DB_PASSWORD}';
CREATE DATABASE payment OWNER payment;
CREATE ROLE "order" LOGIN PASSWORD '${ORDER_DB_PASSWORD}';
CREATE DATABASE "order" OWNER "order";
CREATE ROLE temporal LOGIN CREATEDB PASSWORD '${TEMPORAL_DB_PASSWORD}';
REVOKE CONNECT ON DATABASE jcool_ecommerce, users, inventory, payment, "order" FROM PUBLIC;
SQL
