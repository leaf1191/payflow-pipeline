-- 부하 종료 후 원천 DB 의 최종 상태. Snowflake 최종 테이블과 대조하는 정답지다.
-- 주의: 이건 "최종 상태" 비교일 뿐 "이벤트 누락" 검증이 아니다.
-- UPDATE 는 원천에서 덮어써지므로 PENDING→SUCCESS→REFUND 라는 3개의 CDC 이벤트가
-- 있었다는 사실을 이 테이블만으로는 알 수 없다.
--
--   psql -v ON_ERROR_STOP=1 -h <host> -U app -d app -f k6/sql/verify.sql

-- 서버 전역 statement_timeout(기본 30s)은 OLTP 문장을 보호하기 위한 값이다.
-- 아래 전수 집계는 그보다 오래 걸릴 수 있으므로 이 세션에서만 푼다.
SET statement_timeout = 0;

-- flush.sql 이 넣은 센티널 행을 전 구간에서 제외한다. 센티널은 S3 sink 의 마지막 파일을
-- 닫기 위한 더미이고 비즈니스 데이터가 아니다. 실행마다 누적되므로 반드시 걸러야 한다.
-- Snowflake 쪽 COPY/MERGE 에도 같은 필터가 있어야 한다.
CREATE TEMP VIEW v_users AS
    SELECT * FROM users WHERE NOT starts_with(user_id, '__flush_');
CREATE TEMP VIEW v_merchants AS
    SELECT * FROM merchants WHERE NOT starts_with(merchant_id, '__flush_');
CREATE TEMP VIEW v_products AS
    SELECT * FROM products WHERE NOT starts_with(product_id, '__flush_');
CREATE TEMP VIEW v_transactions AS
    SELECT * FROM transactions WHERE NOT starts_with(transaction_id, '__flush_');
CREATE TEMP VIEW v_transaction_items AS
    SELECT * FROM transaction_items WHERE NOT starts_with(item_id, '__flush_');

\echo '== row counts =='
SELECT
    (SELECT count(*) FROM v_users)             AS users,
    (SELECT count(*) FROM v_merchants)         AS merchants,
    (SELECT count(*) FROM v_products)          AS products,
    (SELECT count(*) FROM v_transactions)      AS transactions,
    (SELECT count(*) FROM v_transaction_items) AS transaction_items;

\echo '== transaction status distribution =='
SELECT status, count(*) AS cnt
  FROM v_transactions
 GROUP BY status
 ORDER BY cnt DESC;

\echo '== user grade distribution =='
SELECT user_grade, count(*) AS cnt
  FROM v_users
 GROUP BY user_grade
 ORDER BY user_grade;

\echo '== products: alive vs soft deleted =='
SELECT
    count(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted,
    count(*) FILTER (WHERE deleted_at IS NULL)     AS alive
  FROM v_products;

\echo '== DQ: negative price or quantity =='
SELECT count(DISTINCT transaction_id) AS bad_transactions,
       count(*)                       AS bad_items
  FROM v_transaction_items
 WHERE unit_price < 0 OR quantity < 0 OR item_amount < 0;

\echo '== DQ: total_amount != sum(item_amount) =='
SELECT count(*) AS mismatched_transactions
  FROM v_transactions t
 WHERE t.total_amount <> (
           SELECT COALESCE(sum(i.item_amount), 0)
             FROM transaction_items i
            WHERE i.transaction_id = t.transaction_id);

-- 결제는 조회부터 두 INSERT 까지가 CTE 한 문장이다. 한 문장은 곧 한 트랜잭션이므로
-- transactions 행이 있으면 items 행도 반드시 있어야 한다. 이 값이 0 이 아니면
-- 원자성이 깨진 것이고, 곧 후방 정합 레이어가 반쪽 결제를 보게 된다는 뜻이다.
\echo '== atomicity: transactions without any item (must be 0) =='
SELECT count(*) AS orphan_transactions
  FROM v_transactions t
 WHERE NOT EXISTS (
           SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.transaction_id);

\echo '== integrity: items referencing a product that no longer exists (must be 0) =='
SELECT count(*) AS orphan_items
  FROM v_transaction_items i
  LEFT JOIN products p ON p.product_id = i.product_id
 WHERE p.product_id IS NULL;

-- 전체 행을 한 번에 해시하면 메모리가 터지므로 16개 버킷으로 쪼갠다.
-- Snowflake 에서 같은 식으로 계산해 버킷 단위로 비교하면 불일치 구간을 좁힐 수 있다.
\echo '== checksum buckets (compare against Snowflake) =='
SELECT left(md5(transaction_id), 1) AS bucket,
       count(*)                     AS cnt,
       sum(total_amount)            AS total_amount_sum
  FROM v_transactions
 GROUP BY 1
 ORDER BY 1;
