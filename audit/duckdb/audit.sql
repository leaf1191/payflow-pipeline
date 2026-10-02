-- PostgreSQL ~ S3 구간 이벤트 유실 감사.
--
-- 입력은 run_audit.sh 가 만든 _sources.sql 의 뷰들이다(raw_k6, raw_products,
-- raw_transactions, raw_transaction_items). 이 파일은 경로를 모른다.
--
-- [무엇을 증명하는가]
-- k6 가 성공으로 기록한 모든 CDC 이벤트가 S3 parquet 에 1건 이상 존재한다.
--
-- [왜 포함 검사 하나로 충분한가]
-- 감사 키는 (table, pk, kind) 이고, 감사 부하는 "한 PK 에 같은 kind 의 소스 이벤트가 최대
-- 1건" 임이 SQL 가드로 보장되는 트래픽만 돌린다(k6/scripts/lib/audit.js). 그래서 키 하나가
-- 곧 소스 이벤트 하나이고, S3 에 그 키가 있으면 도달한 것, 없으면 유실이다.
-- 재전송으로 같은 키가 여러 행이어도 상관없다. 그건 at-least-once 의 증거로 따로 센다.
--
-- 반대 방향(S3 에만 있는 키)은 보지 않는다. k6 가 응답을 못 받아 기록하지 못한 커밋,
-- database/sql 의 조용한 재시도가 다른 PK 에 남긴 이벤트, 이전 실행의 이벤트가 전부 거기
-- 섞이고, 그 어느 것도 유실이 아니다. 감사 부하가 유일성 트래픽만 쓰는 덕에 그런 이벤트가
-- 이미 기록된 키와 겹치는 일도 없다.

----------------------------------------------------------------------
-- 1. parquet 정규화
----------------------------------------------------------------------
-- 토픽마다 PK 컬럼과 kind 의 근거가 다르므로 테이블별로 읽어 공통 모양으로 편다.
--   transactions:  op c -> 'insert', op u -> after.status (상태 변경과 환불이 여기서 갈린다)
--   products:      op c -> 'insert', op u 이고 deleted_at 이 있으면 'soft_delete'
--                  (이름/가격 변경은 감사 대상이 아니라 kind 가 NULL 로 남고 조인에 안 걸린다)
--   transaction_items: op c -> 'insert'
-- op 'r' 은 incremental snapshot, 'd' 는 이 파이프라인에 없다(삭제는 전부 soft delete).
CREATE OR REPLACE TEMP VIEW cdc_events AS
WITH unified AS (
    SELECT 'transactions' AS tbl, r.op, r."source"."lsn" AS lsn,
           r.after.transaction_id AS pk,
           CASE WHEN r.op = 'c' THEN 'insert' ELSE r.after.status END AS kind
      FROM raw_transactions r
    UNION ALL
    SELECT 'products', r.op, r."source"."lsn",
           r.after.product_id,
           CASE WHEN r.op = 'c' THEN 'insert'
                WHEN r.after.deleted_at IS NOT NULL THEN 'soft_delete'
           END
      FROM raw_products r
    UNION ALL
    SELECT 'transaction_items', r.op, r."source"."lsn",
           r.after.item_id,
           CASE WHEN r.op = 'c' THEN 'insert' END
      FROM raw_transaction_items r
)
SELECT tbl, op, lsn, pk, kind
  FROM unified
 WHERE op IN ('c', 'u')
   AND kind IS NOT NULL
   -- flush.sql 의 센티널. S3 sink 의 마지막 파일을 닫기 위한 더미이고 k6 가 만든 것이 아니다.
   AND NOT starts_with(pk, '__flush_');

CREATE OR REPLACE TEMP VIEW k6_events AS
SELECT t AS tbl, k AS pk, e AS kind FROM raw_k6;

----------------------------------------------------------------------
-- 2. 전제 점검
----------------------------------------------------------------------
-- k6 쪽 키는 유일해야 한다. 같은 키가 두 번 기록됐다면 "PK 당 최대 1건" 가드가 깨졌거나
-- 감사 대상이 아닌 트래픽이 섞인 것이다. 그 경우 아래 포함 검사는 의미가 없다.
.print ''
.print '== precondition: duplicate keys on the k6 side (must be 0) =='
SELECT tbl, kind, count(*) AS duplicate_keys
  FROM (SELECT tbl, pk, kind FROM k6_events GROUP BY ALL HAVING count(*) > 1)
 GROUP BY ALL
 ORDER BY tbl, kind;

----------------------------------------------------------------------
-- 3. 포함 검사
----------------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE cdc_keys AS
SELECT tbl, pk, kind,
       count(*)            AS parquet_rows,  -- 물리 행 수 (재전송 포함)
       count(DISTINCT lsn) AS source_events  -- 1 이어야 한다. 2 이상이면 가드가 깨진 것
  FROM cdc_events
 GROUP BY ALL;

CREATE OR REPLACE TEMP TABLE k6_keys AS
SELECT DISTINCT tbl, pk, kind FROM k6_events;

CREATE OR REPLACE TEMP TABLE missing AS
SELECT k.tbl, k.pk, k.kind
  FROM k6_keys k
  ANTI JOIN cdc_keys c
    ON k.tbl = c.tbl AND k.pk = c.pk AND k.kind = c.kind;

.print ''
.print '== coverage: k6 keys vs S3 arrival by table / kind =='
SELECT k.tbl, k.kind,
       count(*)                                   AS k6_keys,
       count(*) - count(m.pk)                     AS arrived,
       count(m.pk)                                AS missing
  FROM k6_keys k
  LEFT JOIN missing m ON m.tbl = k.tbl AND m.pk = k.pk AND m.kind = k.kind
 GROUP BY ALL
 ORDER BY k.tbl, k.kind;

.print ''
.print '== RESULT =='
SELECT CASE WHEN count(*) = 0
            THEN 'PASS - every k6-recorded event reached S3'
            ELSE 'FAIL - ' || count(*) || ' events recorded by k6 are absent from S3'
       END AS result
  FROM missing;

----------------------------------------------------------------------
-- 4. 증거
----------------------------------------------------------------------
-- 커넥터를 죽였다 살린 만큼 재전송이 일어났다는 증거. 이번 실행의 키로 한정해서 센다.
-- 이 값이 0 이면 at-least-once 가 실제로 발동하지 않은 것이고, 그렇다면 후방의 중복 제거를
-- 증명했다고 말할 수 없다.
.print ''
.print '== at-least-once: redelivered rows among audited keys =='
SELECT c.tbl,
       sum(c.parquet_rows)                     AS parquet_rows,
       count(*)                                AS keys,
       sum(c.parquet_rows) - count(*)          AS redelivered,
       count(*) FILTER (WHERE c.source_events > 1) AS keys_with_multiple_lsn   -- must be 0
  FROM cdc_keys c
  JOIN k6_keys k ON k.tbl = c.tbl AND k.pk = c.pk AND k.kind = c.kind
 GROUP BY c.tbl
 ORDER BY c.tbl;

.print ''
.print '== sample missing (up to 30) =='
SELECT * FROM missing ORDER BY tbl, kind, pk LIMIT 30;
