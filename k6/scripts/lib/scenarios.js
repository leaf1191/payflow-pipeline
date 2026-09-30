import { BEHAVIOR } from './config.js';
import { execSql, runSql } from './db.js';
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

function classify(rows) {
    if (rows === null) {
        return RESULT.error;
    }
    return rows.length > 0 ? RESULT.executed : RESULT.noop;
}

function rollback() {
    execSql('tx_rollback', 'ROLLBACK');
}

// 시나리오 1 / 7 / 8 의 공통 본체.
//
// 유저가 상인 몇 곳을 둘러보고 거기 있는 상품 중 몇 종류를 담는 흐름.
// BEGIN → SELECT → INSERT(transactions) → INSERT(items) → COMMIT 다섯 왕복으로 나눈다.
// 한 문장으로 합칠 수도 있지만 일부러 나눈다. 이유가 둘이다.
//
//   1. 트랜잭션이 여러 왕복에 걸쳐 열려 있어야 여러 VU 의 LSN 구간이 실제로 겹친다.
//      txA(lsn 100~300) 안에 txB(200~250) 가 끼는 상황이 만들어지고, Debezium 은 이걸
//      커밋 순서로 재정렬해 내보낸다. LSN 순서와 CDC 출력 순서가 어긋나는 이 상태가
//      후방 정합 레이어(Snowflake MERGE)가 실제로 견뎌야 하는 조건이다.
//   2. 수량·금액·수수료·오염값 생성을 JS 가 맡는다. random() 과 산술을 SQL 에 넣으면
//      부하 발생기의 연산이 측정 대상인 DB 의 CPU 를 먹는다.
//
// 상품 조회는 트랜잭션 안에서 하므로, 잡힌 목록은 COMMIT 까지 같은 스냅샷으로 유지된다.
//
// corruption: 'none' | 'negative' | 'mismatch'
function insertPayment(state, corruption) {
    const merchants = randomMerchantIds(randInt(1, BEHAVIOR.browseMerchantsMax));
    const itemLimit = randInt(1, BEHAVIOR.itemsPerTxMax);
    const op = corruption === 'none' ? 'new_payment' : `dq_${corruption}`;

    if (!execSql('tx_begin', 'BEGIN')) {
        return RESULT.error;
    }

    const products = runSql(
        'product_browse',
        `SELECT product_id, price
           FROM products
          WHERE merchant_id IN (${merchants.map(quote).join(', ')})
            AND deleted_at IS NULL
          ORDER BY random()
          LIMIT ${itemLimit}`
    );

    if (products === null) {
        rollback();
        return RESULT.error;
    }
    if (products.length === 0) {
        // 둘러본 상인들에게 살아있는 상품이 하나도 없었다.
        rollback();
        return RESULT.skipped;
    }

    // 오염은 항상 첫 번째 품목에 넣는다. 잡힌 품목 수가 유동적이라
    // 무작위 위치를 노리면 품목이 적을 때 오염이 통째로 누락된다.
    const negateIndex = corruption === 'negative' ? 0 : -1;
    const negateUnitPrice = percent(50);

    const transactionId = state.nextTransactionId();
    const itemValues = [];
    let itemAmountSum = 0;

    for (let i = 0; i < products.length; i += 1) {
        let unitPrice = Number(products[i].price);
        let quantity = randInt(1, 5);

        if (i === negateIndex) {
            // 음수 단가와 음수 수량을 반반씩 섞어 두 패턴 모두 DQ 로 잡히는지 본다.
            if (negateUnitPrice) {
                unitPrice = -unitPrice;
            } else {
                quantity = -quantity;
            }
        }

        const itemAmount = unitPrice * quantity;
        itemAmountSum += itemAmount;

        itemValues.push(
            `(${quote(`${transactionId}_i${i + 1}`)}, ${quote(transactionId)}, ` +
                `${quote(products[i].product_id)}, ${unitPrice}, ${quantity}, ${itemAmount}, ` +
                `${Math.round(itemAmount * PG_FEE_RATE)}, ${Math.round(itemAmount * PLATFORM_FEE_RATE)})`
        );
    }

    // sum(item_amount) 와 total_amount 를 일부러 어긋나게 한다(0 차이는 제외).
    const totalAmount =
        corruption === 'mismatch'
            ? itemAmountSum + randInt(1, 50000) * (percent(50) ? 1 : -1)
            : itemAmountSum;

    const txRows = runSql(
        op,
        `INSERT INTO transactions (transaction_id, user_id, total_amount, status)
         VALUES ($1, $2, ${totalAmount}, 'PENDING')
         RETURNING transaction_id`,
        [transactionId, randomUserId()]
    );
    if (txRows === null || txRows.length === 0) {
        rollback();
        return RESULT.error;
    }

    const itemRows = runSql(
        'items_insert',
        `INSERT INTO transaction_items
             (item_id, transaction_id, product_id, unit_price, quantity, item_amount, pg_fee, platform_fee)
         VALUES ${itemValues.join(', ')}
         RETURNING item_id`
    );
    if (itemRows === null || itemRows.length === 0) {
        rollback();
        return RESULT.error;
    }

    if (!execSql('tx_commit', 'COMMIT')) {
        rollback();
        return RESULT.error;
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
             RETURNING transaction_id`,
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
             RETURNING transaction_id`,
            [randomUserId()]
        )
    );
}

// 4. 상품 정보 변경 (이름/가격/카테고리 변경 또는 soft delete)
// 상인이 자기 진열대에서 상품 하나를 고르는 흐름. 상인으로 범위를 좁힌 뒤 고르므로
// ORDER BY random() 이 훑는 건 그 상인의 상품뿐이다.
export function productUpdate() {
    const merchantId = randomMerchantId();
    const pickOne = `(
        SELECT product_id
          FROM products
         WHERE merchant_id = $1 AND deleted_at IS NULL
         ORDER BY random()
         LIMIT 1
    )`;

    if (percent(BEHAVIOR.softDeleteRatio)) {
        return classify(
            runSql(
                'product_soft_delete',
                `UPDATE products
                    SET deleted_at = NOW(), updated_at = NOW()
                  WHERE product_id = ${pickOne}
                 RETURNING product_id`,
                [merchantId]
            )
        );
    }

    return classify(
        runSql(
            'product_update',
            `UPDATE products AS p
                SET product_name = $2,
                    category = $3,
                    price = GREATEST(100, (p.price * ${randInt(70, 130)}) / 100),
                    updated_at = NOW()
              WHERE p.product_id = ${pickOne}
             RETURNING p.product_id`,
            [merchantId, `product-rev${randInt(1, 999999)}`, pick(CATEGORIES)]
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
             RETURNING u.user_id`,
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
