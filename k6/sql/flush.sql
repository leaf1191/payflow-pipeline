-- S3 sink 의 마지막 파일을 닫기 위한 센티널(더미) 이벤트 주입.
--
-- [왜 필요한가]
-- S3 sink 는 rotate.interval.ms 로 파일을 닫는데, 이 창은 벽시계가 아니라 "현재 파일의 첫
-- 레코드 타임스탬프" 기준이다. 벽시계(rotate.schedule.interval.ms)를 쓰면 파일 경계가
-- 비결정적이 되어 재시작 시 오프셋 n~m 청크가 재현되지 않고, exactly-once 와도 호환되지 않는다.
-- 그래서 레코드 시계를 쓸 수밖에 없고, 그 대가로 트래픽이 끊기면 마지막 배치가 영원히
-- 버퍼에 남는다. 이걸 유실로 오판하지 않으려면 뒤에서 밀어주는 이벤트가 필요하다.
--
-- [왜 이렇게 많이 넣는가]
-- 로테이션 판정은 토픽-파티션 단위다. 파티션은 Avro 직렬화된 키의 해시로 결정되므로
-- DB 에서 특정 파티션을 노릴 수 없다. 쿠폰 수집가 문제라 파티션 수 p 에 대해 최소 p·ln(p),
-- 실무적으로는 p 의 5~10 배를 쏘면 모든 파티션이 덮인다. 기본값 200 은 파티션 20개 기준이다.
--
-- [실행 시점]
-- 부하를 멈춘 뒤 rotate.interval.ms + 여유(기본 60s + 10s)만큼 기다린 다음 실행한다.
-- 센티널의 타임스탬프가 열려 있는 파일의 창을 넘어야 로테이션이 걸린다. 바로 실행하면
-- 창 안에 들어가서 아무 일도 일어나지 않는다.
--
-- [센티널 자신은 S3 에 안 나타난다]
-- 로테이션을 트리거한 레코드는 닫히는 파일이 아니라 다음 파일의 첫 레코드가 된다.
-- 즉 이번 실행에서는 버퍼에 남는다. 하지만 다음 실행 때 flush 되므로 verify 와 DW 양쪽에서
-- 접두어 '__flush_' 로 영구 제외해야 한다.
--
-- [하드 삭제하지 않는다]
-- 센티널을 DELETE 로 치우면, 평소 hard delete 가 없는 이 파이프라인에 DELETE 이벤트가
-- 끼어들어 DW 가 처리해야 하는 이벤트 종류가 달라진다. 그냥 남겨두고 접두어로 제외한다.
--
--   sleep 70
--   psql -v ON_ERROR_STOP=1 -h <host> -U app -d app -f k6/sql/flush.sql
--   psql -v ON_ERROR_STOP=1 -v cnt=500 ... -f k6/sql/flush.sql   # 파티션이 많을 때

\if :{?cnt}
\else
\set cnt 200
\endif

BEGIN;

-- now() 는 트랜잭션 내에서 고정되므로 다섯 INSERT 가 같은 태그를 쓴다.
-- 태그에 실행 시각을 넣어 실행마다 PK 가 겹치지 않게 한다.
\echo '== inserting flush sentinels =='

INSERT INTO merchants (merchant_id, merchant_name, business_number)
SELECT t.tag || g, 'flush-sentinel', t.tag || g
  FROM generate_series(1, :cnt) AS g,
       (SELECT '__flush_' || to_char(now(), 'YYYYMMDDHH24MISS') || '_' AS tag) AS t;

INSERT INTO users (user_id, user_name, email, birth_year, user_grade)
SELECT t.tag || g, 'flush-sentinel', t.tag || g || '@flush.invalid', 1970, 'BRONZE'
  FROM generate_series(1, :cnt) AS g,
       (SELECT '__flush_' || to_char(now(), 'YYYYMMDDHH24MISS') || '_' AS tag) AS t;

INSERT INTO products (product_id, merchant_id, product_name, category, price)
SELECT t.tag || g, t.tag || g, 'flush-sentinel', 'FLUSH', 1
  FROM generate_series(1, :cnt) AS g,
       (SELECT '__flush_' || to_char(now(), 'YYYYMMDDHH24MISS') || '_' AS tag) AS t;

-- total_amount 를 sum(item_amount) 와 일치시킨다. 접두어 제외를 깜빡했을 때
-- 센티널이 DQ 위반으로 잡혀 오염 데이터처럼 보이는 일을 막는다.
INSERT INTO transactions (transaction_id, user_id, total_amount, status)
SELECT t.tag || g, t.tag || g, 1, 'PENDING'
  FROM generate_series(1, :cnt) AS g,
       (SELECT '__flush_' || to_char(now(), 'YYYYMMDDHH24MISS') || '_' AS tag) AS t;

INSERT INTO transaction_items
    (item_id, transaction_id, product_id, unit_price, quantity, item_amount, pg_fee, platform_fee)
SELECT t.tag || g || '_i1', t.tag || g, t.tag || g, 1, 1, 1, 0, 0
  FROM generate_series(1, :cnt) AS g,
       (SELECT '__flush_' || to_char(now(), 'YYYYMMDDHH24MISS') || '_' AS tag) AS t;

COMMIT;

\echo '== sentinel counts (cumulative across runs) =='
SELECT
    (SELECT count(*) FROM merchants         WHERE starts_with(merchant_id, '__flush_'))   AS merchants,
    (SELECT count(*) FROM users             WHERE starts_with(user_id, '__flush_'))       AS users,
    (SELECT count(*) FROM products          WHERE starts_with(product_id, '__flush_'))    AS products,
    (SELECT count(*) FROM transactions      WHERE starts_with(transaction_id, '__flush_')) AS transactions,
    (SELECT count(*) FROM transaction_items WHERE starts_with(item_id, '__flush_'))       AS transaction_items;
