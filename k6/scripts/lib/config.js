// 모든 튜닝 값은 환경변수로 뺀다. 코드 수정 없이 부하 프로파일과 가중치를 바꾸기 위함.

function num(name, fallback) {
    const raw = __ENV[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        throw new Error(`env ${name} must be a number, got '${raw}'`);
    }
    return parsed;
}

function str(name, fallback) {
    const raw = __ENV[name];
    return raw === undefined || raw === '' ? fallback : raw;
}

export const PG = {
    host: str('POSTGRES_HOST', '127.0.0.1'),
    port: num('POSTGRES_PORT', 5432),
    user: str('POSTGRES_USER', 'app'),
    password: str('POSTGRES_PASSWORD', 'change-me'),
    database: str('POSTGRES_DB', 'app'),
    sslmode: str('POSTGRES_SSLMODE', 'disable'),
};

// 별도 파이썬 스크립트가 CSV 로 만들어 COPY 로 주입한 기준 데이터의 규모.
// PK 가 순차 증가라는 계약 덕분에 k6 는 조회 없이 ID 를 조립할 수 있다.
// users / merchants 는 항상 존재한다고 가정하고 조회 없이 참조한다.
// products 는 부하 중 생성·삭제되므로 아래 값은 "ID 탐색 범위"일 뿐이고,
// 실제 사용 가능 여부는 매 결제마다 SELECT 로 확인한다.
export const SOURCE = {
    users: num('SOURCE_USERS', 50000),
    merchants: num('SOURCE_MERCHANTS', 500),
    products: num('SOURCE_PRODUCTS', 20000),
    // 신규 상품이 들어갈 여유 구간의 상한. SOURCE_PRODUCTS 초과분이 5번 시나리오의 몫이다.
    productIdMax: num('PRODUCT_ID_MAX', 0),
};

if (SOURCE.productIdMax === 0) {
    SOURCE.productIdMax = Math.ceil(SOURCE.products * 1.2);
}

// CSV 생성 스크립트와 맞춰야 하는 PK 포맷. 기본값은 u_000001 / m_00001 / p_000001.
export const ID_FORMAT = {
    userPrefix: str('USER_ID_PREFIX', 'u_'),
    userPad: num('USER_ID_PAD', 6),
    merchantPrefix: str('MERCHANT_ID_PREFIX', 'm_'),
    merchantPad: num('MERCHANT_ID_PAD', 5),
    productPrefix: str('PRODUCT_ID_PREFIX', 'p_'),
    productPad: num('PRODUCT_ID_PAD', 6),
};

export const LOAD = {
    vus: num('VUS', 100),
    baseTps: num('BASE_TPS', 1000),
    peakTps: num('PEAK_TPS', 5000),
    warmupTps: num('WARMUP_TPS', 200),
    warmupDuration: str('WARMUP_DURATION', '30s'),
    rampDuration: str('RAMP_DURATION', '1m'),
    steadyDuration: str('STEADY_DURATION', '3m'),
    peakDuration: str('PEAK_DURATION', '2m'),
    drainDuration: str('DRAIN_DURATION', '30s'),
};

// 상대 가중치. 합이 100 일 필요는 없다.
// 결제 생성이 후속 시나리오(상태 변경·환불)의 재고를 만들어주므로 가장 높게 둔다.
export const WEIGHTS = {
    new_payment: num('W_NEW_PAYMENT', 45),
    status_change: num('W_STATUS_CHANGE', 25),
    refund: num('W_REFUND', 8),
    product_update: num('W_PRODUCT_UPDATE', 8),
    product_insert: num('W_PRODUCT_INSERT', 3),
    grade_change: num('W_GRADE_CHANGE', 8),
    dq_negative: num('W_DQ_NEGATIVE', 2),
    dq_amount_mismatch: num('W_DQ_AMOUNT_MISMATCH', 2),
};

export const BEHAVIOR = {
    // 결제 1건이 후보로 조회할 상품 개수. 이 중 살아있는 것만 실제로 결제한다.
    productCandidates: num('PRODUCT_CANDIDATES', 3),
    // VU 가 기억하는 PENDING transaction_id 상한. 메모리 상한을 고정하기 위한 값.
    trackedIdLimit: num('TRACKED_ID_LIMIT', 2000),
    // 상품 변경 중 soft delete 비율(%).
    softDeleteRatio: num('SOFT_DELETE_RATIO', 10),
    // 상태 변경 결과의 분포(%). 합 100 기준.
    statusSuccessRatio: num('STATUS_SUCCESS_RATIO', 80),
    statusFailedRatio: num('STATUS_FAILED_RATIO', 12),
};

export function connectionString() {
    const auth = `${encodeURIComponent(PG.user)}:${encodeURIComponent(PG.password)}`;
    const params = `sslmode=${PG.sslmode}&application_name=k6-load`;
    return `postgres://${auth}@${PG.host}:${PG.port}/${PG.database}?${params}`;
}
