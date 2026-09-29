// CDC 파이프라인 부하 발생기.
// 8종 트랜잭션을 가중치에 따라 무작위로 골라 PostgreSQL 에 직접 실행한다.
// TPS 기준 제어(ramping-arrival-rate)이며 VU 는 상한으로만 쓴다.
//
// k6 요약은 부하 발생기가 정상 동작했는지만 보여준다.
// 실제 처리량은 postgres_exporter 실측값(Grafana), 정합성·멱등성은 DB/S3 실데이터로 판정한다.

import { LOAD, SOURCE, WEIGHTS } from './lib/config.js';
import { closeDb, db } from './lib/db.js';
import { buildWeightedPicker } from './lib/random.js';
import { HANDLERS, RESULT } from './lib/scenarios.js';
import { createVuState } from './lib/state.js';

const pickScenario = buildWeightedPicker(WEIGHTS);
const FALLBACK_TO_NEW_PAYMENT = (__ENV.FALLBACK_TO_NEW_PAYMENT || '1') === '1';

export const options = {
    scenarios: {
        txn_mix: {
            executor: 'ramping-arrival-rate',
            startRate: LOAD.warmupTps,
            timeUnit: '1s',
            preAllocatedVUs: LOAD.vus,
            maxVUs: LOAD.vus,
            gracefulStop: '30s',
            stages: [
                { target: LOAD.warmupTps, duration: LOAD.warmupDuration },
                { target: LOAD.baseTps, duration: LOAD.rampDuration },
                { target: LOAD.baseTps, duration: LOAD.steadyDuration },
                { target: LOAD.peakTps, duration: LOAD.rampDuration },
                { target: LOAD.peakTps, duration: LOAD.peakDuration },
                { target: LOAD.baseTps, duration: LOAD.rampDuration },
                { target: LOAD.baseTps, duration: LOAD.steadyDuration },
                { target: 0, duration: LOAD.drainDuration },
            ],
        },
    },
    // SQL 이 깨진 채로 돈 실험은 무효다. 부하 발생기 자체의 건강 지표만 걸어 둔다.
    thresholds: {
        sql_errors: ['count==0'],
    },
    // 목표 TPS 를 못 채우면 요약의 dropped_iterations 가 올라간다.
    // VU 상한이 병목인지, DB 가 병목인지 구분하는 1차 지표로 쓴다.
};

export function setup() {
    const runId = __ENV.RUN_ID || Date.now().toString(36);

    const actual = db.query(
        `SELECT
             (SELECT count(*) FROM merchants) AS merchants,
             (SELECT count(*) FROM users)     AS users,
             (SELECT count(*) FROM products)  AS products`
    )[0];

    // users/merchants 는 조회 없이 ID 를 조립하므로, 설정값이 실제보다 크면 FK 위반이 쏟아진다.
    // products 는 상인을 통해 조회하므로 개수를 알 필요가 없다.
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

    const maxConnections = Number(db.query('SHOW max_connections')[0].max_connections);
    if (maxConnections < LOAD.vus + 30) {
        console.warn(
            `max_connections=${maxConnections} is tight for VUS=${LOAD.vus} ` +
                '(+ debezium replication slots and admin sessions). raise it to at least VUS + 50.'
        );
    }

    console.log(`run_id=${runId} source=${JSON.stringify(counts)} max_connections=${maxConnections}`);

    return { runId: runId };
}

let state = null;

export default function (data) {
    if (state === null) {
        state = createVuState(data.runId);
    }

    const op = pickScenario();
    const result = HANDLERS[op](state);

    // 상태 전이 대상이나 살아있는 상품 후보가 없으면 결제 생성으로 대체한다.
    // 그냥 넘기면 워밍업 구간에서 원천 DB 가 받는 실제 TPS 가 목표보다 낮아진다.
    if (result === RESULT.skipped && FALLBACK_TO_NEW_PAYMENT && op !== 'new_payment') {
        HANDLERS.new_payment(state);
    }
}

export function teardown() {
    closeDb();
}
