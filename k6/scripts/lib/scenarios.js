import { BEHAVIOR } from './config.js';
import { runSql } from './db.js';
import { pick, percent, quote, randInt } from './random.js';
import { randomMerchantId, randomMerchantIds, randomUserId } from './state.js';

export const RESULT = {
    executed: 'executed',
    skipped: 'skipped', // 대상이 없어 실행 자체를 못 함
    noop: 'noop', // 실행했으나 조건 불일치로 0건 변경
    error: 'error',
};

const GRADES = ['BRONZE', 'SILVER', 'GOLD', 'VIP'];
const CATEGORIES = ['FOOD', 'FASHION', 'DIGITAL', 'BEAUTY', 'LIVING', 'SPORTS', 'BOOK', 'TRAVEL'];

const PG_FEE_RATE = 0.025;
const PLATFORM_FEE_RATE = 0.05;

// 감사 키에 시간 컬럼은 들어가지 않는다. 키는 (table, pk, kind) 이고 kind 는 RETURNING 의
// status 같은 결과 값에서 나온다. 어떤 UPDATE 가 감사 대상이 되는지는 lib/audit.js 참고.

function classify(rows) {
    if (rows === null) {
        return RESULT.error;
    }
    return rows.length > 0 ? RESULT.executed : RESULT.noop;
}

// 시나리오 1 / 7 / 8 의 공통 본체.
//
// 유저가 상인 몇 곳을 둘러보고 거기 있는 상품 중 몇 종류를 담는 흐름을 한 문장에 담는다.
// 상품 조회와 삽입을 따로 보내면 그 사이에 상품이 soft delete 될 수 있지만,
// 한 문장은 단일 스냅샷 위에서 실행되므로 그 창이 없다. 왕복도 1회다.
//
// BEGIN/COMMIT 을 따로 보내지 않는 이유: xk6-sql 의 Database 는 커넥션 풀이고 트랜잭션 API 가
// 없다. 문장마다 다른 커넥션을 받으면 트랜잭션이 조용히 깨진다. 한 번의 query 안에
// BEGIN~COMMIT 을 문자열로 다 넣는 방법은 중간 결과를 JS 로 가져올 수 없어 이 CTE 와 같아진다.
//
// 수량과 오염 부호는 JS 가 만들어 VALUES 로 주입한다. DB 에 남는 난수는 상품 선택의
// ORDER BY random() 하나뿐이고, 그건 상인 범위(수십 행)로 한정된다.
//
// corruption: 'none' | 'negative' | 'mismatch'
function insertPayment(state, corruption) {
    const transactionId = state.nextTransactionId();
    const merchants = randomMerchantIds(randInt(1, BEHAVIOR.browseMerchantsMax));
    const itemLimit = randInt(1, BEHAVIOR.itemsPerTxMax);

    // 오염은 항상 첫 번째 품목에 넣는다. 실제로 몇 개가 잡힐지 모르는 상태에서
    // 무작위 위치를 노리면 품목 수가 적을 때 오염이 통째로 누락된다.
    const negateUnitPrice = corruption === 'negative' && percent(50);
    const negateQuantity = corruption === 'negative' && !negateUnitPrice;

    // rn 은 조회 결과의 행 번호. 실제로 잡힌 품목이 itemLimit 보다 적으면 남는 행은 조인에서 빠진다.
    // 첫 행에만 타입을 명시한다. row_number() 가 bigint 라 rn 쪽 타입을 맞춰야 조인이 성립한다.
    const spec = [];
    for (let i = 1; i <= itemLimit; i += 1) {
        const quantity = randInt(1, 5) * (i === 1 && negateQuantity ? -1 : 1);
        const priceSign = i === 1 && negateUnitPrice ? -1 : 1;
        spec.push(
            i === 1
                ? `(1::bigint, ${quantity}::int, ${priceSign}::int)`
                : `(${i}, ${quantity}, ${priceSign})`
        );
    }

    // sum(item_amount) 와 total_amount 를 일부러 어긋나게 한다(0 차이는 제외).
    const drift = corruption === 'mismatch' ? randInt(1, 50000) * (percent(50) ? 1 : -1) : 0;

    const rows = runSql(
        corruption === 'none' ? 'new_payment' : `dq_${corruption}`,
        `WITH cand AS MATERIALIZED (
             SELECT row_number() OVER () AS rn, s.product_id, s.price
               FROM (
                   SELECT product_id, price
                     FROM products
                    WHERE merchant_id IN (${merchants.map(quote).join(', ')})
                      AND deleted_at IS NULL
                    ORDER BY random()
                    LIMIT ${itemLimit}
               ) AS s
         ),
         spec (rn, quantity, price_sign) AS (
             VALUES ${spec.join(', ')}
         ),
         priced AS MATERIALIZED (
             SELECT c.rn,
                    c.product_id,
                    c.price * s.price_sign               AS unit_price,
                    s.quantity                           AS quantity,
                    c.price * s.price_sign * s.quantity  AS item_amount
               FROM cand c
               JOIN spec s ON s.rn = c.rn
         ),
         tx AS (
             INSERT INTO transactions (transaction_id, user_id, total_amount, status)
             SELECT ${quote(transactionId)}, ${quote(randomUserId())}, sum(item_amount) + ${drift}, 'PENDING'
               FROM priced
             HAVING count(*) > 0
             RETURNING transaction_id
         )
         INSERT INTO transaction_items
             (item_id, transaction_id, product_id, unit_price, quantity, item_amount, pg_fee, platform_fee)
         SELECT tx.transaction_id || '_i' || p.rn,
                tx.transaction_id,
                p.product_id,
                p.unit_price,
                p.quantity,
                p.item_amount,
                round(p.item_amount * ${PG_FEE_RATE})::int,
                round(p.item_amount * ${PLATFORM_FEE_RATE})::int
           FROM priced p CROSS JOIN tx
         RETURNING item_id, transaction_id`
    );

    if (rows === null) {
        return RESULT.error;
    }
    if (rows.length === 0) {
        // 둘러본 상인들에게 살아있는 상품이 하나도 없었다. HAVING 이 막아 결제 자체가 생기지 않는다.
        return RESULT.skipped;
    }

    state.pending.push(transactionId);
    return RESULT.executed;
}

// 1. 새 결제 생성 (PENDING)
export function newPayment(state) {
    return insertPayment(state, 'none');
}

// 2. 결제 상태 변경 (PENDING → SUCCESS / FAILED / CANCELLED)
export function statusChange(state) {
    const transactionId = state.pending.takeRandom();
    if (transactionId === null) {
        return RESULT.skipped;
    }

    const roll = Math.random() * 100;
    let nextStatus = 'CANCELLED';
    if (roll < BEHAVIOR.statusSuccessRatio) {
        nextStatus = 'SUCCESS';
    } else if (roll < BEHAVIOR.statusSuccessRatio + BEHAVIOR.statusFailedRatio) {
        nextStatus = 'FAILED';
    }

    return classify(
        runSql(
            'status_change',
            `UPDATE transactions
                SET status = $2, updated_at = NOW()
              WHERE transaction_id = $1 AND status = 'PENDING'
             RETURNING transaction_id, status`,
            [transactionId, nextStatus]
        )
    );
}

// 3. 결제 환불 (SUCCESS → REFUND)
// 유저를 먼저 고르고 그 유저의 SUCCESS 결제를 찾는다. 실제 환불 요청의 진입 경로와 같고,
// (user_id, status) 인덱스를 타므로 전체 스캔이 없다.
// 동시에 같은 유저를 고른 VU 와 부딪히지 않도록 SKIP LOCKED 로 비켜 간다.
export function refund() {
    return classify(
        runSql(
            'refund',
            `UPDATE transactions
                SET status = 'REFUND', updated_at = NOW()
              WHERE transaction_id = (
                    SELECT transaction_id
                      FROM transactions
                     WHERE user_id = $1 AND status = 'SUCCESS'
                     ORDER BY created_at
                     LIMIT 1
                       FOR UPDATE SKIP LOCKED
                )
             RETURNING transaction_id, status`,
            [randomUserId()]
        )
    );
}

// 4. 상품 정보 변경 (이름/가격/카테고리 변경 또는 soft delete)
// 상인이 자기 진열대에서 상품 하나를 고르는 흐름. 상인으로 범위를 좁힌 뒤 고르므로
// ORDER BY random() 이 훑는 건 그 상인의 상품뿐이다.
//
// product_name 의 state.nextRevision() 토큰은 (runId, vuId, sequence) 조합이라 전역 유일하다.
// parquet 의 after 블록만 보고 어느 VU 의 몇 번째 변경인지 짚기 위한 추적용이다.
//
// soft delete 는 따로 export 한다. 감사 부하(cdc_audit.js)는 한 PK 가 반복 변경되는 이름/가격
// 경로를 빼고 soft delete 만 쓰기 때문이다. deleted_at IS NULL 가드 덕에 PK 당 최대 1회다.
const PICK_ALIVE_PRODUCT = `(
    SELECT product_id
      FROM products
     WHERE merchant_id = $1 AND deleted_at IS NULL
     ORDER BY random()
     LIMIT 1
)`;

export function productSoftDelete() {
    return classify(
        runSql(
            'product_soft_delete',
            `UPDATE products
                SET deleted_at = NOW(), updated_at = NOW()
              WHERE product_id = ${PICK_ALIVE_PRODUCT}
             RETURNING product_id`,
            [randomMerchantId()]
        )
    );
}

export function productUpdate(state) {
    if (percent(BEHAVIOR.softDeleteRatio)) {
        return productSoftDelete();
    }

    return classify(
        runSql(
            'product_update',
            `UPDATE products AS p
                SET product_name = $2,
                    category = $3,
                    price = GREATEST(100, (p.price * ${randInt(70, 130)}) / 100),
                    updated_at = NOW()
              WHERE p.product_id = ${PICK_ALIVE_PRODUCT}
             RETURNING p.product_id, p.product_name, p.category, p.price`,
            [randomMerchantId(), `product-${state.nextRevision()}`, pick(CATEGORIES)]
        )
    );
}

// 5. 상품 추가. ID 공간에 상한이 없으므로 카탈로그는 계속 늘어날 수 있다.
export function productInsert(state) {
    return classify(
        runSql(
            'product_insert',
            `INSERT INTO products (product_id, merchant_id, product_name, category, price)
             VALUES ($1, $2, $3, $4, ${randInt(2, 200) * 500})
             RETURNING product_id`,
            [state.nextProductId(), randomMerchantId(), `product-new-${randInt(1, 999999)}`, pick(CATEGORIES)]
        )
    );
}

// 6. 유저 멤버십 등급 변경 (승급 75%, 강등 25%, 단계 건너뜀 허용)
export function gradeChange() {
    const step = randInt(1, 3);
    const delta = percent(75) ? step : -step;
    const gradeArray = `ARRAY[${GRADES.map(quote).join(', ')}]`;

    // 현재 등급을 모르는 상태에서 전이시켜야 하므로 현재 값 기준 계산을 SQL 에 맡긴다.
    // 양 끝(BRONZE/VIP)에서는 클램프되어 같은 값이 나오므로 <> 조건으로 무의미한 UPDATE 를 막는다.
    return classify(
        runSql(
            'grade_change',
            `UPDATE users AS u
                SET user_grade = g.next_grade, updated_at = NOW()
               FROM (
                   SELECT ${gradeArray}[
                              LEAST(${GRADES.length}, GREATEST(1,
                                  array_position(${gradeArray}, user_grade) + ${delta}))
                          ] AS next_grade
                     FROM users
                    WHERE user_id = $1
               ) AS g
              WHERE u.user_id = $1
                AND u.deleted_at IS NULL
                AND u.user_grade <> g.next_grade
             RETURNING u.user_id, u.user_grade`,
            [randomUserId()]
        )
    );
}

// 7. DQ: 음수 단가 / 음수 수량
export function dqNegative(state) {
    return insertPayment(state, 'negative');
}

// 8. DQ: sum(item_amount) != total_amount
export function dqAmountMismatch(state) {
    return insertPayment(state, 'mismatch');
}

export const HANDLERS = {
    new_payment: newPayment,
    status_change: statusChange,
    refund: refund,
    product_update: productUpdate,
    product_insert: productInsert,
    grade_change: gradeChange,
    dq_negative: dqNegative,
    dq_amount_mismatch: dqAmountMismatch,
};
