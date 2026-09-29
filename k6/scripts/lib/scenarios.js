import { BEHAVIOR } from './config.js';
import { runSql } from './db.js';
import { pick, percent, quote, randInt } from './random.js';
import { newProductId, randomMerchantId, randomProductId, randomUserId } from './state.js';

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

// 임의로 만든 ID 가 실제로 살아있는 상품인지 확인한다.
// ORDER BY random() 대신 PK 조회 몇 건으로 끝나므로 인덱스만 타고 끝난다.
// 상품이 부하 중 생성·삭제되기 때문에 이 확인 없이는 삭제된 상품을 결제하게 된다.
function findLiveProducts() {
    const candidates = [];
    for (let i = 0; i < BEHAVIOR.productCandidates; i += 1) {
        candidates.push(quote(randomProductId()));
    }

    return runSql(
        'product_lookup',
        `SELECT product_id, price
           FROM products
          WHERE product_id IN (${candidates.join(', ')})
            AND deleted_at IS NULL`
    );
}

// 시나리오 1 / 7 / 8 의 공통 본체.
// corruption: 'none' | 'negative' | 'mismatch'
function insertPayment(state, corruption) {
    const products = findLiveProducts();
    if (products === null) {
        return RESULT.error;
    }
    if (products.length === 0) {
        // 후보 ID 가 전부 미생성이거나 soft delete 상태. 결제할 상품이 없으니 건너뛴다.
        return RESULT.skipped;
    }

    const transactionId = state.nextTransactionId();
    const corruptedIndex = corruption === 'negative' ? randInt(0, products.length - 1) : -1;

    const itemValues = [];
    let itemAmountSum = 0;

    for (let i = 0; i < products.length; i += 1) {
        // 조회한 현재 단가를 그대로 스냅샷으로 남긴다. 이후 상품 가격이 바뀌어도 결제 기록은 불변이다.
        let unitPrice = Number(products[i].price);
        let quantity = randInt(1, 5);

        if (i === corruptedIndex) {
            // 음수 단가와 음수 수량을 반반씩 섞어 두 패턴 모두 DQ 로 잡히는지 본다.
            if (percent(50)) {
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

    let totalAmount = itemAmountSum;
    if (corruption === 'mismatch') {
        // sum(item_amount) 와 total_amount 를 일부러 어긋나게 한다(0 차이는 제외).
        totalAmount = itemAmountSum + randInt(1, 50000) * (percent(50) ? 1 : -1);
    }

    // data-modifying CTE 로 두 테이블 삽입을 한 문장에 담는다.
    // 단일 문장이므로 암묵적 트랜잭션이고, FK 검사는 문장 종료 시점에 수행되어 안전하다.
    const rows = runSql(
        corruption === 'none' ? 'new_payment' : `dq_${corruption}`,
        `WITH t AS (
             INSERT INTO transactions (transaction_id, user_id, total_amount, status)
             VALUES (${quote(transactionId)}, ${quote(randomUserId())}, ${totalAmount}, 'PENDING')
         )
         INSERT INTO transaction_items
             (item_id, transaction_id, product_id, unit_price, quantity, item_amount, pg_fee, platform_fee)
         VALUES ${itemValues.join(', ')}
         RETURNING 1`
    );

    if (rows !== null && rows.length > 0) {
        state.pending.push(transactionId);
    }
    return classify(rows);
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

    const rows = runSql(
        'status_change',
        `UPDATE transactions
            SET status = $2, updated_at = NOW()
          WHERE transaction_id = $1 AND status = 'PENDING'
         RETURNING 1`,
        [transactionId, nextStatus]
    );
    return classify(rows);
}

// 3. 결제 환불 (SUCCESS → REFUND)
// 유저를 먼저 고르고 그 유저의 SUCCESS 결제를 찾는다. 실제 환불 요청의 진입 경로와 같고,
// (user_id, status) 인덱스를 타므로 전체 스캔이 없다.
// 동시에 같은 유저를 고른 VU 와 부딪히지 않도록 SKIP LOCKED 로 비켜 간다.
export function refund() {
    const rows = runSql(
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
         RETURNING 1`,
        [randomUserId()]
    );
    return classify(rows);
}

// 4. 상품 정보 변경 (이름/가격/카테고리 변경 또는 soft delete)
export function productUpdate() {
    const productId = randomProductId();

    if (percent(BEHAVIOR.softDeleteRatio)) {
        return classify(
            runSql(
                'product_soft_delete',
                `UPDATE products
                    SET deleted_at = NOW(), updated_at = NOW()
                  WHERE product_id = $1 AND deleted_at IS NULL
                 RETURNING 1`,
                [productId]
            )
        );
    }

    return classify(
        runSql(
            'product_update',
            `UPDATE products
                SET product_name = $2, category = $3, price = ${randInt(2, 200) * 500}, updated_at = NOW()
              WHERE product_id = $1 AND deleted_at IS NULL
             RETURNING 1`,
            [productId, `product-${productId}-rev${randInt(1, 999)}`, pick(CATEGORIES)]
        )
    );
}

// 5. 상품 추가
// 시드 구간 밖의 여유 ID 를 쓴다. 이미 있으면 0건이고, 성공하면 이후 결제 후보에 자연히 포함된다.
export function productInsert() {
    const productId = newProductId();

    return classify(
        runSql(
            'product_insert',
            `INSERT INTO products (product_id, merchant_id, product_name, category, price)
             VALUES ($1, $2, $3, $4, ${randInt(2, 200) * 500})
             ON CONFLICT (product_id) DO NOTHING
             RETURNING 1`,
            [productId, randomMerchantId(), `product-new-${productId}`, pick(CATEGORIES)]
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
    const rows = runSql(
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
         RETURNING 1`,
        [randomUserId()]
    );
    return classify(rows);
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
