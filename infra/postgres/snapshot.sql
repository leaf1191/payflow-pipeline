-- Incremental snapshot 트리거.
--
-- snapshot.mode=no_data 이므로 커넥터는 기동 시 데이터를 읽지 않고 스트리밍만 시작한다.
-- 기준 데이터(CSV COPY)를 DW 로 넘기려면 이 신호를 넣어 chunk 단위 스냅샷을 돌린다.
-- chunk 는 1024행씩이라 문장 하나가 짧고, 전역 statement_timeout 에 걸리지 않는다.
--
--   psql -v ON_ERROR_STOP=1 -h <host> -U app -d app -f infra/postgres/snapshot.sql
--
-- 진행 상황은 Debezium 로그의 'Incremental snapshot' 항목으로 확인한다.
-- 중단하려면 type 을 'stop-snapshot' 으로 같은 형식의 신호를 넣는다.

INSERT INTO debezium_signal (id, type, data)
VALUES (
    gen_random_uuid()::text,
    'execute-snapshot',
    '{"data-collections": ["public.users","public.merchants","public.products","public.transactions","public.transaction_items"], "type": "incremental"}'
);

SELECT id, type FROM debezium_signal ORDER BY id DESC LIMIT 1;
