# k6 부하 발생기

PostgreSQL 에 직접 트랜잭션을 밀어넣어 CDC 파이프라인의 입력을 만든다.
HTTP 계층이 없으므로 `xk6-sql` + postgres 드라이버로 빌드한 커스텀 k6 바이너리를 쓴다.

## 구성

```
sql/verify.sql                부하 후 원천 DB 최종 상태 (Snowflake 대조용 정답지)
sql/flush.sql                 S3 sink 의 마지막 파일을 닫는 센티널 주입
scripts/transaction_load.js   본 부하 (TPS 제어)
scripts/cdc_audit.js          이벤트 유실 감사용 부하 (감사 키를 NDJSON 으로 기록)
scripts/smoke.js              8종 SQL 1회씩 실행하는 사전 점검
scripts/lib/config.js         환경변수 파싱
scripts/lib/db.js             커넥션 + runSql()
scripts/lib/audit.js          감사 키 기록기 (기본 비활성)
scripts/lib/random.js         난수 / 가중치 추첨
scripts/lib/state.js          VU 로컬 PENDING 큐 + PK 조립
scripts/lib/scenarios.js      8종 SQL 본체
```

S3 대조는 저장소 루트의 `audit/` 에 있다(`run_audit.sh`, `duckdb/init.sql`, `duckdb/audit.sql`).

기준 데이터(users / merchants / products)는 별도 파이썬 스크립트가 CSV 로 만들고
DB 초기화 때 `COPY` 로 주입한다. k6 쪽에 시드 로직은 없다.

## 실행 순서

```bash
cp .env.example .env            # 접속 정보, 원천 데이터 규모, 부하 프로파일 수정
docker compose --profile load build

# (CSV 시드 주입은 별도 스크립트로 선행)
# 커넥터는 snapshot.mode=no_data 라 기동만으로는 기준 데이터를 읽지 않는다.
# 시드를 DW 로 넘기려면 incremental snapshot 신호를 한 번 넣는다.
psql -h <PG_HOST> -U app -d app -f ../infra/postgres/snapshot.sql

./run.sh smoke                  # SQL 검증
./run.sh transaction_load       # 본 부하

# S3 sink 의 마지막 파일은 트래픽이 끊기면 안 닫힌다.
# rotate.interval.ms + 여유만큼 기다린 뒤 센티널을 넣어 밀어낸다.
sleep 70
psql -h <PG_HOST> -U app -d app -f sql/flush.sql

psql -h <PG_HOST> -U app -d app -f sql/verify.sql
```

`K6_USE_LOCAL=1` 이면 도커 대신 로컬 `k6` 바이너리를 쓴다.

## 원천 데이터와의 계약

PK 가 순차 증가라는 전제 위에서 k6 가 ID 를 직접 조립한다. CSV 생성 스크립트와 아래를 맞춰야 한다.

| env | 뜻 |
| --- | --- |
| `SOURCE_USERS`, `SOURCE_MERCHANTS` | 조회 없이 참조하므로 **실제 행 수를 넘으면 안 된다** (넘으면 FK 위반) |
| `*_ID_PREFIX`, `*_ID_PAD` | PK 문자열 포맷. 기본 `u_000001` / `m_00001` |

상품은 여기 없다. ID 를 짐작하지 않고 항상 상인을 통해 조회하므로 개수도 포맷도 알 필요가 없다.
부하 중 생기는 상품은 `pnew_<run>_<vu>_<n>` 이름을 쓰므로 CSV 시드의 PK 와 섞이지 않는다.

`setup()` 이 실제 행 수를 세어 `SOURCE_USERS`/`SOURCE_MERCHANTS` 보다 적으면 실행을 중단한다.

## 부하 프로파일

VU 는 상한(기본 100)으로만 두고 실제 부하는 TPS 로 제어한다(`ramping-arrival-rate`).

| 구간 | TPS | 기본 길이 |
| --- | --- | --- |
| warmup | `WARMUP_TPS` (200) | 30s |
| ramp → base | 1000 | 1m |
| base 유지 | `BASE_TPS` (1000) | 3m |
| ramp → peak | 5000 | 1m |
| peak 유지 | `PEAK_TPS` (5000) | 2m |
| base 복귀 | 1000 | 1m + 3m |
| drain | 0 | 30s |

감사 실행(`cdc_audit`)은 별도 프로파일이다. `AUDIT_TPS`(300), `AUDIT_VUS`(50),
`AUDIT_DURATION`(10m) 으로 제어하고 `constant-arrival-rate` 를 쓴다.

1 TPS = 1 iteration = SQL 한 문장 = 한 트랜잭션이다. 다만 k6 가 보낸 목표와 DB 가 실제로 처리한
양은 다르다. **실측값은 Grafana 를 본다.**

달성 가능한 TPS 상한은 `VUS × (1 / RTT)` 에 묶인다. 피크 5000 TPS 를 노린다면 k6 를 DB 와 같은
VPC 안에서 돌려야 하고, 로컬에서 돌리는 검증용 실행은 애초에 낮은 TPS 를 전제로 한다.

## 시나리오와 기본 가중치

| # | 시나리오 | 대상 선택 방식 | env | 기본값 |
| --- | --- | --- | --- | --- |
| 1 | 새 결제 생성 (PENDING) | 상인 1~3곳을 둘러보고 그 상품 중 1~5종 | `W_NEW_PAYMENT` | 45 |
| 2 | 상태 변경 (PENDING → SUCCESS/FAILED/CANCELLED) | VU 로컬 PENDING 큐 | `W_STATUS_CHANGE` | 25 |
| 3 | 환불 (SUCCESS → REFUND) | 유저를 고른 뒤 그 유저의 SUCCESS 결제 | `W_REFUND` | 8 |
| 4 | 상품 변경 (이름/가격/카테고리, 10% soft delete) | 상인을 고른 뒤 그 상인의 상품 하나 | `W_PRODUCT_UPDATE` | 8 |
| 5 | 상품 추가 | 상인을 고르고 새 ID 발급 | `W_PRODUCT_INSERT` | 3 |
| 6 | 멤버십 등급 변경 (승급 75%, 강등 25%, 단계 건너뜀 허용) | 랜덤 PK, 전이 계산은 SQL 에서 | `W_GRADE_CHANGE` | 8 |
| 7 | DQ: 음수 단가 / 음수 수량 | 1번과 동일 | `W_DQ_NEGATIVE` | 2 |
| 8 | DQ: `total_amount != sum(item_amount)` | 1번과 동일 | `W_DQ_AMOUNT_MISMATCH` | 2 |

1~6 은 정합성이 맞는 데이터만 생성하고, 7~8 만 의도적으로 오염시킨다.

## 설계 메모

- **상품은 항상 상인을 통해 도달한다.** 임의 ID 를 만들어 존재를 확인하는 방식은 ID 공간에 상한이
  생기고, soft delete 가 누적되면 살아있는 후보가 말라 결제가 성립하지 않는다.
  상인으로 범위를 좁히면 나오는 건 전부 살아있는 상품이고, 카탈로그를 무한히 늘릴 수 있다.
  `ORDER BY random()` 이 훑는 범위도 한 상인의 상품(수십 건)으로 한정된다.
- **결제는 조회부터 삽입까지 CTE 한 문장이다.** 상인 조회 → 상품 선택 → `transactions` →
  `transaction_items` 가 하나의 문장이고, 따라서 하나의 트랜잭션이다. 왕복도 1회다.
  `BEGIN`/`COMMIT` 을 따로 보내지 않는다. xk6-sql 의 `Database` 는 커넥션 풀이고 트랜잭션 API 가
  없어서, 문장마다 다른 커넥션을 받으면 트랜잭션이 **조용히** 깨진다.
  한 번의 `query()` 안에 `BEGIN~COMMIT` 을 문자열로 넣는 방법은 중간 결과를 JS 로 꺼낼 수 없어
  이 CTE 와 결국 같아진다.
- **난수는 JS 가 만들어 `VALUES` 로 주입한다.** 수량과 오염 부호를 `spec(rn, quantity, price_sign)`
  으로 넘기고 `rn` 으로 조인한다. DB 에 남는 난수는 상품 선택의 `ORDER BY random()` 하나뿐이고,
  그것도 상인 범위(수십 행)로 한정된다. 부하 발생기의 연산이 측정 대상인 DB 의 CPU 를 먹지 않게 하려는 것이다.
- **짧은 트랜잭션이어도 LSN 은 뒤섞인다.** 한 문장도 행마다 WAL 레코드를 만들고,
  동시 실행 중인 다른 트랜잭션의 레코드가 그 사이에 낀다. 게다가 논리 디코딩은 **커밋 순서로**
  재정렬해 내보내므로, LSN 오름차순과 CDC 출력 순서가 어긋나는 상황은 트랜잭션 길이와 무관하게
  동시성만 있으면 발생한다. 긴 트랜잭션은 그 정도를 키울 뿐이라 굳이 왕복을 늘리지 않았다.
  덧붙여 **같은 PK 에 대해서는 행 락이 직렬화하므로 LSN 순서와 커밋 순서가 항상 일치한다.**
  PK 단위로 동작하는 `MERGE`/SCD2 가 안전한 근거가 여기에 있다.
- **환불은 유저에서 출발한다.** 실제 환불 요청의 진입 경로와 같고 `(user_id, status)` 인덱스를 탄다.
  같은 유저를 동시에 고른 VU 와 부딪히지 않도록 `FOR UPDATE SKIP LOCKED` 로 비켜 간다.
- **PENDING 상태 변경만 VU 로컬 큐를 쓴다.** `status='PENDING'` 을 DB 에서 찾으면 수천 TPS 를 못 낸다.
  각 VU 가 자기가 만든 `transaction_id` 만 링버퍼에 들고 전이시키므로 VU 간 행 경합도 없다.
- **`RETURNING` + `query()` 로 변경 행 수를 확인한다.** 드라이버마다 제각각인 `rowsAffected` 를 피한다.

## 측정은 k6 가 하지 않는다

k6 요약에 남기는 건 `sql_errors` 하나뿐이고, 이건 "부하 발생기가 고장났는가"만 본다.
`sql_errors > 0` 이면 그 실험은 무효다.

나머지는 전부 다른 데서 본다.

| 보려는 것 | 어디서 |
| --- | --- |
| 원천 DB 실제 처리량 (평균·피크 TPS) | Grafana `Postgres Commit Rate (actual TPS)` — `rate(pg_stat_database_xact_commit[1m])` |
| CDC 가 캡처해야 할 행 변경량 | Grafana `Postgres Row Change Rate` — `tup_inserted/updated/deleted` |
| VU 100 이 커넥션 상한에 닿는지 | Grafana `Postgres Connections vs max_connections` |
| 복제 슬롯이 붙잡은 WAL | Grafana `Replication Slot Retained WAL` |
| Consumer Lag / GC Pause / Heap | Grafana 기존 패널 |
| 정합성·중복 제거·멱등성 | 원천 DB(`sql/verify.sql`) ↔ S3 ↔ Snowflake 실데이터 대조 |
| 목표 TPS 미달 여부 | k6 요약의 `dropped_iterations` |

`dropped_iterations` 가 크고 commit rate 가 평탄하면 VU 100 이 병목이므로 `VUS` 를 올린다.
commit rate 가 먼저 꺾이면 DB 가 병목이다.

### 최종 상태 비교와 이벤트 누락 검증은 다르다

`sql/verify.sql` 은 **최종 상태**의 정답지다. UPDATE 는 원천에서 덮어써지므로
`PENDING → SUCCESS → REFUND` 라는 3개의 CDC 이벤트가 있었다는 사실은 이 테이블에 남지 않는다.
즉 최종 상태가 일치해도 중간 이벤트 유실은 잡히지 않는다.

### 이벤트 단위 감사

`scripts/cdc_audit.js` 가 성공한 모든 이벤트의 감사 키를 NDJSON 으로 남기고,
`audit/` 의 DuckDB 질의가 그걸 S3 parquet 과 대조한다.

```bash
./run.sh cdc_audit              # 이 사이에 debezium / connect-s3 를 여러 번 kill
sleep 70 && psql ... -f sql/flush.sql
../audit/run_audit.sh <RUN_ID>
```

#### 감사 대상은 유일성이 SQL 로 보장되는 트래픽뿐이다

감사 키는 `(table, pk, kind)` 이고 시간은 들어가지 않는다. 감사 부하는 **한 PK 에 같은 kind 의
소스 이벤트가 최대 1건** 임이 WHERE 가드로 보장되는 시나리오만 돌린다.

| 이벤트 | kind | PK 당 1건인 근거 |
| --- | --- | --- |
| INSERT 전부 | `insert` | PK 가 k6 생성값 |
| `status_change` | 결과 status (`SUCCESS`/`FAILED`/`CANCELLED`) | `status='PENDING'` 가드 |
| `refund` | `REFUND` | `status='SUCCESS'` 가드 |
| `product_soft_delete` | `soft_delete` | `deleted_at IS NULL` 가드 |

`transactions` 는 한 PK 에 UPDATE 가 두 번(상태 변경, 환불) 올 수 있지만 `after.status` 가
다르므로 kind 로 갈린다. **`grade_change` 와 `product_update`(이름/가격) 는 감사 부하에서
뺀다.** 한 PK 가 반복 변경되는 경로라 아래의 조용한 재시도가 같은 PK 에 두 번째 이벤트를
만들 수 있고, 그러면 S3 의 어떤 이벤트가 k6 의 어떤 기록에 대응하는지 구별할 수 없다.
이 둘을 빼도 파이프라인에 대한 증명은 약해지지 않는다. Debezium → Kafka → S3 는 이벤트가
같은 PK 를 반복하는지 알지 못하고, 유실은 이벤트 단위로 일어난다. 빠지는 건 **k6 쪽 장부가
모호한 트래픽**이지 파이프라인의 어떤 경로가 아니다.

키가 곧 소스 이벤트이므로 검사는 **단방향 포함** 하나다. k6 가 기록한 모든 키가 S3 에 1건
이상 있으면 PASS 다. 건수를 세지 않고 `DISTINCT` 도 필요 없다. 재전송으로 같은 키가 여러
행이어도 그건 at-least-once 의 증거로 따로 센다.

반대 방향(S3 에만 있는 이벤트)은 보지 않는다. k6 가 응답을 못 받아 기록하지 못한 커밋, 재시도가
다른 PK 에 남긴 이벤트, 이전 실행의 이벤트가 전부 거기 섞이고, 그 어느 것도 유실이 아니다.
그래서 **`sql_errors` 는 감사의 유효성과 무관하다.** 에러가 난 문장은 기록되지 않았고,
기록되지 않은 이벤트는 검증 대상이 아니다. 다만 에러가 많으면 검증 범위가 줄어드니 러너가
참고용으로 같이 찍는다.

#### database/sql 의 조용한 재시도

`xk6-sql` 의 `query()` 는 `*sql.DB.QueryContext` 를 탄다. 드라이버가 `driver.ErrBadConn` 을
돌려주면 표준 라이브러리가 같은 문장을 최대 3회까지 다시 보낸다. **커밋은 됐는데 응답만 못
받은 경우에도** 이 경로를 타므로 원천에 WAL 레코드가 2개 생기고 k6 는 1건으로 센다.
이 루프를 끄는 설정은 표준 라이브러리에 없고, 재시도가 없는 `*sql.Conn` / `*sql.Tx` 는
xk6-sql 이 JS 로 노출하지 않는다(`open`/`query`/`exec`/`close` 뿐).

막을 수 없으므로 **영향을 받지 않게 설계한다.** 감사 대상 트래픽에서 재시도의 두 번째 실행은
가드에 막혀 0건이거나(`status_change`) 다른 PK 를 다시 고른다(`refund`, `soft_delete`).
INSERT 는 PK 충돌로 에러가 난다. 어느 경우에도 이미 기록된 키에 두 번째 이벤트가 생기지
않으므로 포함 검사의 결과가 바뀌지 않는다.

#### 왜 LSN 으로 세지 않는가

유일성 트래픽으로 한정하지 않고 `(pk, updated_at)` 키 안에서 `count(DISTINCT lsn)` 과 k6
건수를 등호로 비교하는 방식도 있었다. 재시도 이벤트가 유실된 이벤트와 같은 키 그룹에
떨어지면 `1 == 1` 로 통과하는 구멍이 있다. 발생 조건이 세 겹(재시도 ∧ 같은 시각 ∧ 그 중
하나 유실)이라 확률은 극히 낮지만 구조적 보장이 아니다. 지금 방식은 그 경우 자체가 성립하지
않는다.

#### 감사 전용 스크립트를 따로 둔 이유

기록은 매 iteration 마다 stdout 쓰기를 동반한다. 그걸 `transaction_load.js` 에 섞으면
측정하려던 대상이 아니라 로거 처리량을 재게 된다. 그래서 둘을 나눴다.

| | `transaction_load.js` | `cdc_audit.js` |
| --- | --- | --- |
| 목적 | 처리량·백프레셔 측정 | 이벤트 유실 0건 증명 |
| TPS | 1000~5000 (`BASE_TPS`/`PEAK_TPS`) | 300 (`AUDIT_TPS`) |
| 시나리오 | 8종 전부 | `grade_change` 제외, `product_update` 는 soft delete 만 |
| 키 기록 | 없음 | `--console-output` 으로 NDJSON |
| `sql_errors` | 측정 무효 | 검증 범위만 감소 |

`lib/audit.js` 는 기본이 꺼져 있고 `cdc_audit.js` 의 init 컨텍스트에서만 켜진다.
본 부하에서 `runSql` 이 치르는 비용은 boolean 검사 한 번이다. 감사 대상이 아닌 op 가
기록기에 들어오면 던져서 멈춘다. 조용히 넘기면 검증 범위가 줄어든 채 PASS 가 찍히기 때문이다.

#### 시간 컬럼이 TIMESTAMP(without tz) 인 이유

Debezium 은 `TIMESTAMPTZ` 를 `time.precision.mode` 와 무관하게 `io.debezium.time.ZonedTimestamp`,
즉 ISO-8601 문자열로 내보낸다. `connect` 모드를 고른 의도는 parquet 에 int64 epoch millis
컬럼을 받는 것인데 `TIMESTAMPTZ` 면 그 설정이 공문이 되고 후방이 문자열을 다시 파싱해야 한다.
`TIMESTAMP` 는 `connect` 모드에서 Kafka Connect `Timestamp`(int64 ms) 로 나간다.
후방은 순서를 LSN 으로 잡으므로 ms 로 충분하다.

전제가 하나 생긴다. `NOW()` 는 timestamptz 를 돌려주고 `TIMESTAMP` 컬럼에 들어갈 때 세션
타임존으로 변환되는데 Debezium 은 그 값을 UTC 로 해석한다. 그래서 compose 에서
`-c timezone=UTC` 로 서버 타임존을 고정했다. 감사 키에는 시간이 없으므로 이 결정은 감사와
독립이다.

#### 출력 읽는 법

`coverage` 표의 `missing` 이 이 실험이 찾는 유실이다. `at-least-once` 표의 `redelivered` 는
이번 실행의 키에 한정해 센 재전송 행 수로, 0 이면 재전송이 실제로 발동하지 않은 것이라
중복 제거를 증명했다고 말할 수 없다. kill 횟수와 `redelivered` 가 같이 올라가는 그림이
핵심 증거다. `keys_with_multiple_lsn` 과 `duplicate keys on the k6 side` 는 둘 다 0 이어야 한다.
0 이 아니면 "PK 당 1건" 가드가 깨졌거나 감사 대상이 아닌 트래픽이 섞인 것이다.

## Postgres 수용량

`VUS=100` 이면 동시 세션이 약 100개다. 기본 `max_connections=100` 으로는 debezium 복제 슬롯과
exporter, psql 자리가 없어 부족하므로 compose 에서 다음을 적용해 두었다
(`infra/{alo,eos}/docker-compose.yml`, 값은 `infra/.env` 로 조정).

```
max_connections=300  shared_buffers=1GB  effective_cache_size=3GB
max_wal_size=8GB  checkpoint_timeout=15min  checkpoint_completion_target=0.9
wal_compression=on  random_page_cost=1.1  synchronous_commit=on
max_slot_wal_keep_size=8GB  idle_in_transaction_session_timeout=300s
```

`synchronous_commit` 은 기본 `on` 이다. 유실 0건을 증명하는 실험이므로 커밋 내구성을 끄면 안 된다.
순수 TPS 상한만 재볼 때에 한해 `POSTGRES_SYNCHRONOUS_COMMIT=off` 를 쓴다.

### WAL 폭주 방어와 슬롯 전진

WAL 은 **가장 뒤처진 복제 슬롯** 기준으로 보존된다. Debezium 이 죽어 있으면 그 슬롯이 전진하지
않아 WAL 이 쌓이고, 디스크가 차면 원천 DB 가 멈춘다. OLTP 가용성이 우선이므로
`max_slot_wal_keep_size` 를 넘기면 슬롯을 버리고 WAL 을 회수한다.
대가는 분명하다. **슬롯이 invalidated 되면 CDC 를 재개할 수 없어 스냅샷을 다시 떠야 한다.**
5000 TPS 로 3분이면 `wal_compression=on` 에서 대략 300MB 안팎이라 8GB 는 충분히 여유롭다.
진행 상황은 Grafana `Replication Slot Retained WAL` 패널로 본다.

Debezium 이 살아 있어도 슬롯이 멈출 수 있다. 캡처 대상 테이블에 변경이 없는 구간이나,
다른 슬롯이 한산해서 전진하지 않는 경우다. 그래서 두 가지를 같이 건다.

- `heartbeat.interval.ms=10000` — 처리한 WAL 오프셋을 주기적으로 ack 한다.
- `heartbeat.action.query` — `debezium_heartbeat` 테이블을 갱신해 WAL 에 실제 변경을 만든다.
  오프셋 ack 만으로는 부족한 상황(다른 DB·다른 슬롯만 바쁜 경우)을 위한 것이고,
  **이 테이블은 publication 에 포함되어야 동작한다.**

`debezium_signal` 과 `debezium_heartbeat` 는 **publication 에는 넣고 `table.include.list` 에서는 뺀다.**
둘의 역할이 다르다. publication 은 Postgres 가 WAL 에서 논리 디코딩할 대상이고,
`table.include.list` 는 디코딩된 이벤트에 적용되는 커넥터 레벨 필터다.
incremental snapshot 의 watermark 는 이 필터보다 앞에서 커넥터가 내부적으로 소비하므로,
publication 에만 있으면 스냅샷은 정상 동작하고 Kafka 발행은 일어나지 않는다.
(Debezium 문서: "If you use the `table.include.list` property, you do not need to include the
signaling data collection in it.")

S3 sink 의 `topics.regex` 도 비즈니스 테이블 5개 화이트리스트로 좁혀 두었다. 위 설정만으로
이미 차단되지만, include list 가 나중에 넓어지거나 새 토픽이 끼어들 때의 2차 방어선이다.

### incremental snapshot 과 VARCHAR PK

PK 가 VARCHAR 이면 주의할 점이 하나 있다. incremental snapshot 은 PK 로 정렬해 chunk 를 나누고
`WHERE pk > <last>` 로 다음 chunk 를 가져오는데, **경계 비교는 커넥터(Java) 쪽에서 문자열 비교로
수행된다.** DB 의 정렬이 기본 collation(문자 가중치 기반)이면 Java 의 코드포인트 순서와 어긋나고,
경계가 틀어지면서 행이 스킵되거나 chunk 가 통째로 커지는 일이 생긴다.

그래서 ID 계열 컬럼을 전부 `COLLATE "C"` 로 선언했다. 바이트 순서라 ASCII ID 에서는 Java 비교와
정확히 일치한다. 부수 효과로 문자열 인덱스 비교도 빨라진다.
이미 만들어진 DB 에는 적용되지 않으므로 볼륨을 새로 만들어야 한다.

타임아웃은 전역으로만 건다(`statement_timeout=30s`, `lock_timeout=5s`,
`idle_in_transaction_session_timeout=60s`). 세션에서 덮어쓰면 전역값이 적용될 세션이 없어
아무 의미가 없기 때문이다. 전역으로 걸 수 있는 건 초기 스냅샷을 incremental snapshot 으로
바꿨기 때문이다. chunk 가 1024행이라 문장 하나가 짧다. 예외는 `sql/verify.sql` 의 전수 집계뿐이고,
그 파일이 스스로 `SET statement_timeout = 0` 으로 푼다.

t3.large(2 vCPU)에 postgres + kafka + connect 2대를 같이 올린 개발 구성에서는 5000 TPS 가 나오지 않는다.
`PEAK_TPS` 를 고정한 채 실측 commit rate 와 `dropped_iterations` 를 같이 보면 그 지점이 곧 한계치다.
