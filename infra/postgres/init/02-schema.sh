#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-EOSQL
    CREATE TABLE users (
        user_id         BIGINT PRIMARY KEY,
        email           TEXT NOT NULL,
        grade           TEXT NOT NULL CHECK (grade IN ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
    );

    CREATE TABLE transactions (
        transaction_id  BIGSERIAL PRIMARY KEY,
        user_id         BIGINT NOT NULL REFERENCES users (user_id),
        amount          NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
        status          TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_transactions_created_at ON transactions (created_at);
    CREATE INDEX idx_transactions_user_id ON transactions (user_id);
    CREATE INDEX idx_users_updated_at ON users (updated_at);

    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${DEBEZIUM_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${DEBEZIUM_USER};

    INSERT INTO users (user_id, email, grade)
    VALUES
        (1, 'user1@example.com', 'BRONZE'),
        (2, 'user2@example.com', 'SILVER'),
        (3, 'user3@example.com', 'GOLD');
EOSQL
