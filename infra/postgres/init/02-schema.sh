#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-EOSQL
    -- users: 멤버십 등급(user_grade)은 SCD Type 2 이력 관리 타겟
    CREATE TABLE users (
        user_id         VARCHAR PRIMARY KEY,
        user_name       VARCHAR NOT NULL,
        email           VARCHAR NOT NULL UNIQUE,
        birth_year      INTEGER,
        user_grade      VARCHAR NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
    );

    -- merchants: 입점 판매자 (정산 대금 청구 주체)
    CREATE TABLE merchants (
        merchant_id     VARCHAR PRIMARY KEY,
        merchant_name   VARCHAR NOT NULL,
        business_number VARCHAR NOT NULL UNIQUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
    );

    -- products: category는 DW 범주화/클러스터링 타겟
    CREATE TABLE products (
        product_id      VARCHAR PRIMARY KEY,
        merchant_id     VARCHAR NOT NULL REFERENCES merchants (merchant_id),
        product_name    VARCHAR NOT NULL,
        category        VARCHAR,
        price           INTEGER NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
    );

    -- transactions: status 변경은 CDC 캡처 대상
    CREATE TABLE transactions (
        transaction_id  VARCHAR PRIMARY KEY,
        user_id         VARCHAR NOT NULL REFERENCES users (user_id),
        total_amount    INTEGER NOT NULL,
        status          VARCHAR NOT NULL
            CHECK (status IN ('PENDING', 'SUCCESS', 'REFUND', 'FAILED', 'CANCELLED')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- transaction_items: 결제 시점 단가 스냅샷 + 수수료 안분
    -- DW 정산 지급액 = item_amount - pg_fee - platform_fee
    CREATE TABLE transaction_items (
        item_id         VARCHAR PRIMARY KEY,
        transaction_id  VARCHAR NOT NULL REFERENCES transactions (transaction_id),
        product_id      VARCHAR NOT NULL REFERENCES products (product_id),
        unit_price      INTEGER NOT NULL,
        quantity        INTEGER NOT NULL,
        item_amount     INTEGER NOT NULL,
        pg_fee          INTEGER NOT NULL DEFAULT 0,
        platform_fee    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_products_merchant_id ON products (merchant_id);
    CREATE INDEX idx_products_category ON products (category);
    CREATE INDEX idx_transactions_user_id ON transactions (user_id);
    CREATE INDEX idx_transactions_status ON transactions (status);
    CREATE INDEX idx_transactions_created_at ON transactions (created_at);
    CREATE INDEX idx_transactions_updated_at ON transactions (updated_at);
    CREATE INDEX idx_transaction_items_transaction_id ON transaction_items (transaction_id);
    CREATE INDEX idx_transaction_items_product_id ON transaction_items (product_id);

    CREATE PUBLICATION dbz_publication FOR TABLE
        users,
        merchants,
        products,
        transactions,
        transaction_items;
EOSQL
