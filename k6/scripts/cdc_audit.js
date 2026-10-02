// 이벤트 단위 감사용 부하. transaction_load.js 와 같은 시나리오를 돌리되,
// 성공한 모든 CDC 이벤트의 감사 키를 NDJSON 으로 내보낸다.
//
// 이 실행 중에 Debezium / S3 sink 를 여러 번 죽였다 살린 뒤, 기록된 키 집합이 S3 parquet 에
// 정확히 같은 수로 존재하는지를 audit/ 의 DuckDB 질의로 판정한다.
//
// [본 부하와 분리한 이유]
// 기록은 매 iteration 마다 stdout 쓰기를 동반한다. 성능 측정용 부하에 그걸 섞으면
// 측정하려던 대상이 아니라 로거 처리량을 재게 된다. 그래서 파일을 나눴고,
// audit.js 는 여기서만 켠다.
//
// [감사 대상 트래픽만 돌린다]
// 한 PK 에 같은 종류의 소스 이벤트가 최대 1건임이 SQL 가드로 보장되는 시나리오만 쓴다.
// grade_change 는 빠지고, product_update 는 soft delete 경로만 쓴다. 이유는 lib/audit.js 참고.
// 본 부하의 가중치를 그대로 쓰되 두 항목만 바꾼다. 가중치 합이 바뀌어도 상대 비율이므로 상관없다.
//
// [k6 ~ PostgreSQL 구간의 에러는 감사를 무효화하지 않는다]
// 이 실험은 PostgreSQL~S3 구간만 본다. 에러가 난 문장은 k6 가 기록하지 않고, 기록하지 않은
// 이벤트는 검증 대상이 아니다. 그래서 sql_errors 에 threshold 를 걸지 않는다.
// 다만 에러가 많으면 검증 범위가 줄어드니 요약의 sql_errors 는 같이 보고한다.

import { AUDIT, SOURCE, WEIGHTS } from './lib/config.js';
import { enable, flush } from './lib/audit.js';
import { closeDb, db } from './lib/db.js';
import { buildWeightedPicker } from './lib/random.js';
import { HANDLERS, RESULT, productSoftDelete } from './lib/scenarios.js';
import { createVuState } from './lib/state.js';

// init 컨텍스트는 VU 마다 실행되므로 모든 VU 런타임에서 기록이 켜진다.
enable();

const AUDIT_WEIGHTS = Object.assign({}, WEIGHTS, { grade_change: 0 });
const AUDIT_HANDLERS = Object.assign({}, HANDLERS, { product_update: productSoftDelete });

const pickScenario = buildWeightedPicker(AUDIT_WEIGHTS);
const FALLBACK_TO_NEW_PAYMENT = (__ENV.FALLBACK_TO_NEW_PAYMENT || '1') === '1';

export const options = {
    scenarios: {
        audit_mix: {
            executor: 'constant-arrival-rate',
            rate: AUDIT.tps,
            timeUnit: '1s',
            duration: AUDIT.duration,
            preAllocatedVUs: AUDIT.vus,
            maxVUs: AUDIT.vus,
            // 진행 중이던 iteration 은 끝까지 간다. 중간에 끊기면 커밋은 됐는데
            // 기록은 안 된 이벤트가 생겨 감사가 UNEXPECTED 를 오탐한다.
            gracefulStop: '60s',
        },
    },
};

export function setup() {
    const runId = __ENV.RUN_ID || Date.now().toString(36);

    const actual = db.query(
        `SELECT
             (SELECT count(*) FROM merchants) AS merchants,
             (SELECT count(*) FROM users)     AS users,
             (SELECT count(*) FROM products)  AS products`
    )[0];

    const counts = {
        users: Number(actual.users),
        merchants: Number(actual.merchants),
        products: Number(actual.products),
    };
    for (const key of ['users', 'merchants']) {
        if (counts[key] < SOURCE[key]) {
            throw new Error(
                `source mismatch: ${key} in db=${counts[key]} < SOURCE_${key.toUpperCase()}=${SOURCE[key]}. ` +
                    'load the CSV seed first or lower the SOURCE_* env'
            );
        }
    }
    if (counts.products === 0) {
        throw new Error('products table is empty: nothing to buy. load the CSV seed first');
    }

    console.log(`audit run_id=${runId} source=${JSON.stringify(counts)}`);

    return { runId: runId };
}

let state = null;

export default function (data) {
    if (state === null) {
        state = createVuState(data.runId);
    }

    const op = pickScenario();
    const result = AUDIT_HANDLERS[op](state);

    if (result === RESULT.skipped && FALLBACK_TO_NEW_PAYMENT && op !== 'new_payment') {
        AUDIT_HANDLERS.new_payment(state);
    }

    // iteration 경계를 넘겨 버퍼링하지 않는다. audit.js 의 설명 참고.
    flush();
}

export function teardown() {
    closeDb();
}
