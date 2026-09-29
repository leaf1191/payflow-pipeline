-- 부하 종료 후 원천 DB 의 최종 상태. Snowflake 최종 테이블과 대조하는 정답지다.
-- 주의: 이건 "최종 상태" 비교일 뿐 "이벤트 누락" 검증이 아니다.
-- UPDATE 는 원천에서 덮어써지므로 PENDING→SUCCESS→REFUND 라는 3개의 CDC 이벤트가
-- 있었다는 사실을 이 테이블만으로는 알 수 없다.
--
--   psql -v ON_ERROR_STOP=1 -h <host> -U app -d app -f k6/sql/verify.sql

\echo '== row counts =='
SELECT
    (SELECT count(*) FROM users)             AS users,
    (SELECT count(*) FROM merchants)         AS merchants,
    (SELECT count(*) FROM products)          AS products,
    (SELECT count(*) FROM transactions)      AS transactions,
    (SELECT count(*) FROM transaction_items) AS transaction_items;

\echo '== transaction status distribution =='
SELECT status, count(*) AS cnt
  FROM transactions
 GROUP BY status
 ORDER BY cnt DESC;

\echo '== user grade distribution =='
SELECT user_grade, count(*) AS cnt
  FROM users
 GROUP BY user_grade
 ORDER BY user_grade;

\echo '== products: seeded vs created during load, soft deleted =='
SELECT
    count(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted,
    count(*) FILTER (WHERE deleted_at IS NULL)     AS alive;

\echo '== DQ: negative price or quantity =='
SELECT count(DISTINCT transaction_id) AS bad_transactions,
       count(*)                       AS bad_items
  FROM transaction_items
 WHERE unit_price < 0 OR quantity < 0 OR item_amount < 0;

\echo '== DQ: total_amount != sum(item_amount) =='
SELECT count(*) AS mismatched_transactions
  FROM transactions t
 WHERE t.total_amount <> (
           SELECT COALESCE(sum(i.item_amount), 0)
             FROM transaction_items i
            WHERE i.transaction_id = t.transaction_id);

\echo '== integrity: items referencing a product that no longer exists (must be 0) =='
SELECT count(*) AS orphan_items
  FROM transaction_items i
  LEFT JOIN products p ON p.product_id = i.product_id
 WHERE p.product_id IS NULL;

-- 전체 행을 한 번에 해시하면 메모리가 터지므로 16개 버킷으로 쪼갠다.
-- Snowflake 에서 같은 식으로 계산해 버킷 단위로 비교하면 불일치 구간을 좁힐 수 있다.
\echo '== checksum buckets (compare against Snowflake) =='
SELECT left(md5(transaction_id), 1) AS bucket,
       count(*)                     AS cnt,
       sum(total_amount)            AS total_amount_sum
  FROM transactions
 GROUP BY 1
 ORDER BY 1;