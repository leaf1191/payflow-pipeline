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

// CDC 이벤트 식별자용 타임스탬프. epoch 밀리초 정수로 받는다.
//
// Debezium 은 Avro 호환성을 위해 Connect 논리 타입(epoch millis)을 쓰므로 parquet 쪽 정밀도가
// 밀리초다. 여기서 us 까지 받아봐야 비교 시점에 잘려 의미가 없고, date_trunc 로 미리 끊어
// Debezium 의 절단 방식과 일치시킨다. 그래야 양쪽 값이 정확히 같아진다.
//
// 그리고 (pk, updated_at_ms) 만으로는 유일하지 않다. 같은 PK 가 같은 밀리초에 두 번 변경될 수
// 있다. 그래서 각 UPDATE 는 바뀐 컬럼(after-image)까지 함께 돌려준다.
// 감사 키는 (op, pk, updated_at_ms, after-image) 다.
function tsMs(column) {
    const alias = column.indexOf('.') >= 0 ? column.split('.')[1] : column;
    return `(extract(epoch from date_trunc('millisecond', ${column})) * 1000)::bigint AS ${alias}_ms`;
}

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
         RETURNING item_id`
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
//
// 감사 키 관점: 대상 PK 를 VU 로컬 링 버퍼에서 꺼내고(takeRandom 은 꺼낸 값을 제거한다)
// WHERE 에 status='PENDING' 가드가 있다. 그래서 한 PK 에 PENDING→X 전이는 정확히 한 번뿐이고
// 그 VU 만 건드린다. 같은 PK 가 같은 밀리초에 두 번 나올 수 없다.
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
             RETURNING transaction_id, status, ${tsMs('updated_at')}`,
            [transactionId, nextStatus]
        )
    );
}

// 3. 결제 환불 (SUCCESS → REFUND)
// 유저를 먼저 고르고 그 유저의 SUCCESS 결제를 찾는다. 실제 환불 요청의 진입 경로와 같고,
// (user_id, status) 인덱스를 타므로 전체 스캔이 없다.
// 동시에 같은 유저를 고른 VU 와 부딪히지 않도록 SKIP LOCKED 로 비켜 간다.
//
// 감사 키 관점: status='SUCCESS' 가드가 있고 결과가 REFUND 라 두 번 선택될 수 없다.
// 한 PK 당 REFUND 이벤트는 최대 한 건이다.
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
             RETURNING transaction_id, status, ${tsMs('updated_at')}`,
            [randomUserId()]
        )
    );
}

// 4. 상품 정보 변경 (이름/가격/카테고리 변경 또는 soft delete)
// 상인이 자기 진열대에서 상품 하나를 고르는 흐름. 상인으로 범위를 좁힌 뒤 고르므로
// ORDER BY random() 이 훑는 건 그 상인의 상품뿐이다.
//
// 감사 키 관점: 여기가 유일하게 한 PK 가 여러 번 변경되는 경로다. 그래서 product_name 에
// state.nextRevision() 토큰을 심는다. (runId, vuId, sequence) 조합이라 전역 유일이고,
// 그 결과 after-image 가 이벤트마다 반드시 달라진다. 밀리초가 겹쳐도 키가 겹치지 않는다.
// 이름을 난수나 고정 문자열로 되돌리면 이 보장이 조용히 사라진다.
//
// soft delete 쪽은 pickOne 의 deleted_at IS NULL 가드 때문에 한 PK 당 최대 한 건이다.
export function productUpdate(state) {
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
                 RETURNING product_id, ${tsMs('updated_at')}`,
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
             RETURNING p.product_id, p.product_name, p.category, p.price, ${tsMs('p.updated_at')}`,
            [merchantId, `product-${state.nextRevision()}`, pick(CATEGORIES)]
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
             RETURNING product_id, ${tsMs('created_at')}`,
            [state.nextProductId(), randomMerchantId(), `product-new-${randInt(1, 999999)}`, pick(CATEGORIES)]
        )
    );
}

// 6. 유저 멤버십 등급 변경 (승급 75%, 강등 25%, 단계 건너뜀 허용)
//
// 감사 키 관점: 여기만 잔여 충돌이 남는다. user_grade 의 값 공간이 4개뿐이라
// after-image 에 넣을 엔트로피가 없다. 행 락이 직렬화하고 <> 가드가 있으므로 연속한 두 이벤트는
// 값이 다르지만, 같은 유저에 같은 밀리초 안에서 3번 이상 변경되며 값이 되돌아오는 경우
// (BRONZE→GOLD→SILVER→GOLD) 1번과 3번의 키가 같아진다.
// 이 경우에도 비교를 멀티셋 건수(k6 건수 <= S3 건수)로 하면 유실은 여전히 잡힌다.
// 키가 합쳐져 k6 가 2건으로 세고 S3 가 1건이면 불일치로 드러난다.
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
             RETURNING u.user_id, u.user_grade, ${tsMs('u.updated_at')}`,
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
