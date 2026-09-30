#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-EOSQL
    -- ID 계열 VARCHAR 은 전부 COLLATE "C" 다.
    --
    -- Debezium incremental snapshot 은 PK 로 정렬해 chunk 를 나누고,
    -- chunk 경계 비교는 커넥터(Java) 쪽에서 String 비교로 수행한다.
    -- DB 의 정렬이 기본 collation(문자 가중치 기반)이면 Java 의 코드포인트 순서와 어긋나,
    -- 경계가 틀어지면서 행이 스킵되거나 중복될 수 있다.
    -- COLLATE "C" 는 바이트 순서라 ASCII ID 에서 Java 비교와 정확히 일치한다.
    -- 부수 효과로 문자열 인덱스 비교도 빨라진다.

    -- users: 멤버십 등급(user_grade)은 SCD Type 2 이력 관리 타겟
    CREATE TABLE users (
        user_id         VARCHAR COLLATE "C" PRIMARY KEY,
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
        merchant_id     VARCHAR COLLATE "C" PRIMARY KEY,
        merchant_name   VARCHAR NOT NULL,
        business_number VARCHAR NOT NULL UNIQUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
    );

    -- products: category는 DW 범주화/클러스터링 타겟
    CREATE TABLE products (
        product_id      VARCHAR COLLATE "C" PRIMARY KEY,
        merchant_id     VARCHAR COLLATE "C" NOT NULL REFERENCES merchants (merchant_id),
        product_name    VARCHAR NOT NULL,
        category        VARCHAR,
        price           INTEGER NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
    );

    -- transactions: status 변경은 CDC 캡처 대상
    CREATE TABLE transactions (
        transaction_id  VARCHAR COLLATE "C" PRIMARY KEY,
        user_id         VARCHAR COLLATE "C" NOT NULL REFERENCES users (user_id),
        total_amount    INTEGER NOT NULL,
        status          VARCHAR NOT NULL
            CHECK (status IN ('PENDING', 'SUCCESS', 'REFUND', 'FAILED', 'CANCELLED')),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- transaction_items: 결제 시점 단가 스냅샷 + 수수료 안분
    -- DW 정산 지급액 = item_amount - pg_fee - platform_fee
    CREATE TABLE transaction_items (
        item_id         VARCHAR COLLATE "C" PRIMARY KEY,
        transaction_id  VARCHAR COLLATE "C" NOT NULL REFERENCES transactions (transaction_id),
        product_id      VARCHAR COLLATE "C" NOT NULL REFERENCES products (product_id),
        unit_price      INTEGER NOT NULL,
        quantity        INTEGER NOT NULL,
        item_amount     INTEGER NOT NULL,
        pg_fee          INTEGER NOT NULL DEFAULT 0,
        platform_fee    INTEGER NOT NULL DEFAULT 0
    );

    -- CDC 인프라 테이블. 비즈니스 데이터가 아니므로 DW 적재 대상에서 제외한다.
    --
    -- debezium_signal: ad-hoc/incremental snapshot 신호. Debezium 이 chunk 경계마다
    -- 이 테이블에 watermark 를 써서 스트림에 끼워 넣으므로 publication 에는 반드시 포함되어야 한다.
    -- 반면 table.include.list 에는 넣지 않는다. include.list 는 디코딩된 이벤트에 적용되는
    -- 커넥터 레벨 필터이고, watermark 는 그 필터보다 앞에서 내부적으로 소비된다.
    -- 즉 publication 에만 있으면 스냅샷은 정상 동작하고 Kafka 발행은 일어나지 않는다.
    CREATE TABLE debezium_signal (
        id      VARCHAR(42) COLLATE "C" PRIMARY KEY,
        type    VARCHAR(32) NOT NULL,
        data    VARCHAR(2048)
    );

    -- debezium_heartbeat: heartbeat.action.query 가 주기적으로 갱신한다.
    -- 캡처 대상 테이블이 한산할 때도 WAL 에 변경을 만들어 복제 슬롯의 confirmed_flush_lsn 을
    -- 전진시키는 것이 목적이다. 이것 없이는 다른 슬롯이나 저트래픽 구간에서 WAL 이 계속 쌓인다.
    CREATE TABLE debezium_heartbeat (
        id           INTEGER PRIMARY KEY,
        connector    VARCHAR NOT NULL,
        heartbeat_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_products_merchant_id ON products (merchant_id);
    CREATE INDEX idx_products_category ON products (category);
    CREATE INDEX idx_transactions_user_id ON transactions (user_id);
    -- 환불 대상 탐색: "이 유저의 SUCCESS 결제" 를 스캔 없이 찾기 위한 인덱스
    CREATE INDEX idx_transactions_user_status ON transactions (user_id, status);
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
        transaction_items,
        debezium_signal,
        debezium_heartbeat;

    -- Debezium 은 읽기 전용이지만 이 두 테이블에는 써야 한다.
    -- signal: 스냅샷 watermark 기록, heartbeat: 슬롯 전진용 더미 변경.
    GRANT SELECT, INSERT, UPDATE, DELETE ON debezium_signal TO ${DEBEZIUM_USER};
    GRANT SELECT, INSERT, UPDATE ON debezium_heartbeat TO ${DEBEZIUM_USER};
EOSQL
