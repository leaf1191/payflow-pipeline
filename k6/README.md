# k6 부하 발생기

PostgreSQL 에 직접 트랜잭션을 밀어넣어 CDC 파이프라인의 입력을 만든다.
HTTP 계층이 없으므로 `xk6-sql` + postgres 드라이버로 빌드한 커스텀 k6 바이너리를 쓴다.

## 구성

```
sql/verify.sql                부하 후 원천 DB 최종 상태 (Snowflake 대조용 정답지)
scripts/transaction_load.js   본 부하 (TPS 제어)
scripts/smoke.js              8종 SQL 1회씩 실행하는 사전 점검
scripts/lib/config.js         환경변수 파싱
scripts/lib/db.js             커넥션 + runSql()
scripts/lib/random.js         난수 / 가중치 추첨
scripts/lib/state.js          VU 로컬 PENDING 큐 + PK 조립
scripts/lib/scenarios.js      8종 SQL 본체
```

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

### 이벤트 단위 감사 키

이벤트 전수 검증은 k6 가 기록한 성공 이벤트 집합이 S3 parquet 에 **포함**되는지를 본다.
단방향인 이유는 커밋은 성공했지만 k6 가 응답을 못 받는 경우가 있어서다. 반대 방향의 초과분은
ALO 중복이고, 그건 유실이 아니라 별도로 세야 하는 증거다.

키는 `(op, pk, updated_at_ms, after-image)` 다. 앞의 셋만으로는 부족하다.
Debezium 이 Avro 호환성을 위해 Connect 논리 타입(epoch millis)을 쓰므로 parquet 의 시간
정밀도가 밀리초이고, 같은 PK 가 같은 밀리초에 두 번 변경될 수 있다. us/ns 로 쪼개도 겹칠
가능성이 남고, 후방 정합은 어차피 커밋 LSN + 트랜잭션 내 LSN(`source.lsn`)을 순서 기준으로
쓰므로 시간 정밀도를 올릴 이유가 없다.

그래서 바뀐 컬럼 값까지 키에 넣는다. 시나리오별로 유일성 근거가 다르다.

| 이벤트 | 유일성 근거 |
| --- | --- |
| INSERT 전부 | PK 가 k6 생성값이라 그 자체로 유일 |
| `status_change` | VU 로컬 링 버퍼에서 꺼내 제거 + `status='PENDING'` 가드 → PK 당 1회 |
| `refund` | `status='SUCCESS'` 가드, 결과가 REFUND → PK 당 최대 1회 |
| `product_soft_delete` | `deleted_at IS NULL` 가드 → PK 당 최대 1회 |
| `product_update` | `product_name` 에 `(runId, vuId, sequence)` 토큰을 심어 after-image 가 항상 다름 |
| `grade_change` | **잔여 충돌 있음** (아래) |

`grade_change` 만 값 공간이 4개뿐이라 심을 엔트로피가 없다. 행 락이 직렬화하고 `<>` 가드가
있어 연속한 두 이벤트는 값이 다르지만, 같은 유저가 같은 밀리초에 3회 이상 변경되며 값이
되돌아오면(`BRONZE→GOLD→SILVER→GOLD`) 1번과 3번의 키가 같아진다.

이 잔여 케이스도 비교를 `DISTINCT` 가 아니라 **멀티셋 건수**로 하면 유실은 그대로 잡힌다.
키가 합쳐져 k6 가 2건으로 세고 S3 가 1건이면 `k6 <= S3` 가 깨진다.
`DISTINCT` 를 쓰면 양쪽이 똑같이 1건으로 붕괴해서 유실이 감춰지고, ALO 중복 증거까지 사라진다.

남는 구멍은 같은 키에서 1건 유실과 1건 중복이 정확히 상쇄되는 경우뿐이다. 중복은 커넥터
재시작 시 오프셋 배치 단위로 발생하므로 하필 그 키, 그 밀리초에서 상쇄될 확률은 무시할 수준이고,
실제 충돌 키 수는 감사 스크립트가 같이 출력하므로 추측하지 않고 확인할 수 있다.

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
