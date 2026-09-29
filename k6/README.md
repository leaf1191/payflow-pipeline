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

./run.sh smoke                  # SQL 검증
./run.sh transaction_load       # 본 부하
psql -h <PG_HOST> -U app -d app -f sql/verify.sql
```

`K6_USE_LOCAL=1` 이면 도커 대신 로컬 `k6` 바이너리를 쓴다.

## 원천 데이터와의 계약

PK 가 순차 증가라는 전제 위에서 k6 가 ID 를 직접 조립한다. CSV 생성 스크립트와 아래를 맞춰야 한다.

| env | 뜻 |
| --- | --- |
| `SOURCE_USERS`, `SOURCE_MERCHANTS` | 조회 없이 참조하므로 **실제 행 수를 넘으면 안 된다** (넘으면 FK 위반) |
| `SOURCE_PRODUCTS` | CSV 로 넣은 상품 수. PK 는 1..N |
| `PRODUCT_ID_MAX` | 상품 ID 공간의 상한. `(SOURCE_PRODUCTS, PRODUCT_ID_MAX]` 구간이 부하 중 생성되는 신규 상품의 자리다. 기본값은 `SOURCE_PRODUCTS * 1.2` |
| `*_ID_PREFIX`, `*_ID_PAD` | PK 문자열 포맷. 기본 `u_000001` / `m_00001` / `p_000001` |

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

여기서 1 TPS = 1 iteration 이고, 결제 생성 계열은 iteration 당 SQL 2회(상품 조회 + 삽입)다.
따라서 k6 의 목표 TPS 와 DB 가 실제로 처리한 TPS 는 일치하지 않는다. **실측값은 Grafana 를 본다.**

## 시나리오와 기본 가중치

| # | 시나리오 | 대상 선택 방식 | env | 기본값 |
| --- | --- | --- | --- | --- |
| 1 | 새 결제 생성 (PENDING) | 상품 후보 3개를 SELECT 해 살아있는 것만 결제 | `W_NEW_PAYMENT` | 45 |
| 2 | 상태 변경 (PENDING → SUCCESS/FAILED/CANCELLED) | VU 로컬 PENDING 큐 | `W_STATUS_CHANGE` | 25 |
| 3 | 환불 (SUCCESS → REFUND) | 유저를 고른 뒤 그 유저의 SUCCESS 결제 | `W_REFUND` | 8 |
| 4 | 상품 변경 (이름/가격/카테고리, 10% soft delete) | 랜덤 PK | `W_PRODUCT_UPDATE` | 8 |
| 5 | 상품 추가 | 여유 ID 구간, `ON CONFLICT DO NOTHING` | `W_PRODUCT_INSERT` | 3 |
| 6 | 멤버십 등급 변경 (승급 75%, 강등 25%, 단계 건너뜀 허용) | 랜덤 PK, 전이 계산은 SQL 에서 | `W_GRADE_CHANGE` | 8 |
| 7 | DQ: 음수 단가 / 음수 수량 | 1번과 동일 | `W_DQ_NEGATIVE` | 2 |
| 8 | DQ: `total_amount != sum(item_amount)` | 1번과 동일 | `W_DQ_AMOUNT_MISMATCH` | 2 |

1~6 은 정합성이 맞는 데이터만 생성하고, 7~8 만 의도적으로 오염시킨다.

## 설계 메모

- **결제 전 상품 생존 확인.** 상품은 부하 중 생성·삭제되므로 임의 ID 가 실제로 쓸 수 있는지
  매번 `SELECT ... WHERE product_id IN (...) AND deleted_at IS NULL` 로 확인한다.
  `ORDER BY random()` 같은 풀스캔 없이 PK 조회 몇 건으로 끝난다. 후보가 전부 죽어 있으면 그 결제는 건너뛴다.
- **환불은 유저에서 출발한다.** 실제 환불 요청의 진입 경로와 같고 `(user_id, status)` 인덱스를 탄다.
  같은 유저를 동시에 고른 VU 와 부딪히지 않도록 `FOR UPDATE SKIP LOCKED` 로 비켜 간다.
- **PENDING 상태 변경만 VU 로컬 큐를 쓴다.** `status='PENDING'` 을 DB 에서 찾으면 수천 TPS 를 못 낸다.
  각 VU 가 자기가 만든 `transaction_id` 만 링버퍼에 들고 전이시키므로 VU 간 행 경합도 없다.
- **`RETURNING 1` + `query()` 로 변경 행 수를 확인한다.** 드라이버마다 제각각인 `rowsAffected` 를 피한다.
- **결제 삽입은 data-modifying CTE 한 문장이다.** 한 문장이라 암묵적으로 원자적이고,
  FK 검사는 문장 종료 시점이라 `transactions` → `transaction_items` 순서가 보장된다.

## 측정은 k6 가 하지 않는다

k6 요약에 남기는 건 `sql_errors` 하나뿐이고, 이건 "부하 발생기가 고장났는가"만 본다.
`sql_errors > 0` 이면 그 실험은 무효다.

나머지는 전부 다른 데서 본다.

| 보려는 것 | 어디서 |
| --- | --- |
| 원천 DB 실제 처리량 | Grafana `Postgres Commit Rate (actual TPS)` — `rate(pg_stat_database_xact_commit[1m])` |
| CDC 가 캡처해야 할 행 변경량 | Grafana `Postgres Row Change Rate` — `tup_inserted/updated/deleted` |
| VU 100 이 커넥션 상한에 닿는지 | Grafana `Postgres Connections vs max_connections` |
| Consumer Lag / GC Pause / Heap | Grafana 기존 패널 |
| 정합성·중복 제거·멱등성 | 원천 DB(`sql/verify.sql`) ↔ S3 ↔ Snowflake 실데이터 대조 |
| 목표 TPS 미달 여부 | k6 요약의 `dropped_iterations` |

`dropped_iterations` 가 크고 commit rate 가 평탄하면 VU 100 이 병목이므로 `VUS` 를 올린다.
commit rate 가 먼저 꺾이면 DB 가 병목이다.

### 최종 상태 비교와 이벤트 누락 검증은 다르다

`sql/verify.sql` 은 **최종 상태**의 정답지다. UPDATE 는 원천에서 덮어써지므로
`PENDING → SUCCESS → REFUND` 라는 3개의 CDC 이벤트가 있었다는 사실은 이 테이블에 남지 않는다.
즉 최종 상태가 일치해도 중간 이벤트 유실은 잡히지 않는다.

이벤트 단위 전수 검증을 하려면 원천에 append-only 이력이 필요하다(미결정, 아래 참고).

## Postgres 수용량

`VUS=100` 이면 동시 세션이 약 100개다. 기본 `max_connections=100` 으로는 debezium 복제 슬롯과
exporter, psql 자리가 없어 부족하므로 compose 에서 다음을 적용해 두었다
(`infra/{alo,eos}/docker-compose.yml`, 값은 `infra/.env` 로 조정).

```
max_connections=300  shared_buffers=1GB  effective_cache_size=3GB
max_wal_size=8GB  checkpoint_timeout=15min  checkpoint_completion_target=0.9
wal_compression=on  random_page_cost=1.1  synchronous_commit=on
```

`synchronous_commit` 은 기본 `on` 이다. 유실 0건을 증명하는 실험이므로 커밋 내구성을 끄면 안 된다.
순수 TPS 상한만 재볼 때에 한해 `POSTGRES_SYNCHRONOUS_COMMIT=off` 를 쓴다.

t3.large(2 vCPU)에 postgres + kafka + connect 2대를 같이 올린 개발 구성에서는 5000 TPS 가 나오지 않는다.
`PEAK_TPS` 를 고정한 채 실측 commit rate 와 `dropped_iterations` 를 같이 보면 그 지점이 곧 한계치다.
