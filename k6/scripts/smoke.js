// 8종 SQL 이 실제 스키마에서 도는지 확인하는 최소 실행.
// 본 부하를 걸기 전에 문법/FK/타입 오류를 먼저 걸러낸다.
//   ./run.sh smoke

import { check } from 'k6';

import { closeDb, db } from './lib/db.js';
import { HANDLERS, RESULT } from './lib/scenarios.js';
import { createVuState } from './lib/state.js';

export const options = {
    scenarios: {
        smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '2m',
        },
    },
};

// 뒤 시나리오가 앞 시나리오의 결과에 의존하므로 순서가 있다.
// 환불은 유저 기준으로 SUCCESS 를 찾기 때문에 여기서는 0건(noop)이 정상일 수 있다.
const ORDER = [
    'product_insert',
    'new_payment',
    'new_payment',
    'new_payment',
    'status_change',
    'status_change',
    'refund',
    'product_update',
    'grade_change',
    'dq_negative',
    'dq_amount_mismatch',
];

export default function () {
    const state = createVuState('smoke');

    for (const op of ORDER) {
        const result = HANDLERS[op](state);
        console.log(`${op}: ${result}`);
        check(null, { [`${op} did not error`]: () => result !== RESULT.error });
    }

    const dq = db.query(
        `SELECT
             (SELECT count(*) FROM transaction_items
               WHERE unit_price < 0 OR quantity < 0 OR item_amount < 0) AS negative_items,
             (SELECT count(*) FROM transactions t
               WHERE t.total_amount <> (
                   SELECT COALESCE(sum(i.item_amount), 0)
                     FROM transaction_items i
                    WHERE i.transaction_id = t.transaction_id)) AS amount_mismatch`
    )[0];

    console.log(`dq_negative_items=${dq.negative_items} dq_amount_mismatch=${dq.amount_mismatch}`);
    check(dq, {
        'dq negative rows exist': (d) => Number(d.negative_items) > 0,
        'dq mismatch rows exist': (d) => Number(d.amount_mismatch) > 0,
    });

    // 결제가 삭제된 상품을 참조하지 않았는지 확인한다(존재 확인 SELECT 가 제 역할을 했는가).
    const orphan = db.query(
        `SELECT count(*) AS c
           FROM transaction_items i
           LEFT JOIN products p ON p.product_id = i.product_id
          WHERE p.product_id IS NULL`
    )[0];
    check(orphan, { 'no items referencing missing products': (o) => Number(o.c) === 0 });
}

export function teardown() {
    closeDb();
}
