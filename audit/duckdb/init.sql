-- DuckDB 세션 초기화. run_audit.sh 가 이 파일을 제일 먼저 읽는다.
--
-- [DuckDB 설정 파일에 대하여]
-- DuckDB CLI 는 시작할 때 ~/.duckdbrc 를 자동으로 읽는다. 그 파일에 무엇이 들어있느냐에 따라
-- 결과가 달라지면 감사가 재현되지 않으므로, 러너는 `-init /dev/null` 로 자동 로딩을 끄고
-- 대신 이 파일을 명시적으로 흘려 넣는다. 세션 설정은 전부 여기에만 있다.
-- 영속 DB 파일도 쓰지 않는다. 입력이 S3 parquet 과 NDJSON 뿐이라 매번 새로 읽으면 된다.

-- 질의 하나라도 실패하면 거기서 멈춘다. 중간 실패를 지나쳐 PASS 가 찍히면 안 된다.
.bail on

INSTALL httpfs;
LOAD httpfs;

-- Debezium 의 ZonedTimestamp 는 GMT 기준 문자열이다. TIMESTAMPTZ 로 캐스팅할 때
-- 세션 타임존이 끼어들지 않도록 UTC 로 고정한다.
SET TimeZone = 'UTC';

-- t3.large(8GB) 기준. 더 큰 장비면 올려도 된다.
SET memory_limit = '4GB';
SET preserve_insertion_order = false;

-- EC2 인스턴스 역할 / 환경변수 / ~/.aws 를 순서대로 시도한다.
-- 리전은 체인이 AWS_REGION 또는 ~/.aws/config 에서 가져온다.
CREATE OR REPLACE SECRET s3_audit (
    TYPE s3,
    PROVIDER credential_chain,
    CHAIN 'env;config;instance'
);

.mode box
.headers on
