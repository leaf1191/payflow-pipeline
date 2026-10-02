// 감사 이벤트 기록기. k6 가 "성공으로 센 CDC 이벤트"를 NDJSON 한 줄씩 내보낸다.
//
// [기본은 꺼져 있다]
// transaction_load.js 는 이 모듈을 켜지 않으므로 runSql 의 훅은 boolean 검사 한 번으로 끝난다.
// 성능 측정용 부하에 stdout 쓰기가 섞이면 그게 곧 측정 대상이 되어버린다.
// cdc_audit.js 만 init 컨텍스트에서 enable() 을 호출한다. init 은 VU 마다 실행되므로
// VU 별 런타임 전부에서 켜진다.
//
// [감사 키는 (table, pk, kind) 이고 시간은 없다]
// 감사 대상은 "한 PK 에 같은 종류의 소스 이벤트가 최대 1건" 임이 SQL 가드로 보장되는
// 트래픽뿐이다. 그래서 키가 곧 소스 이벤트이고, S3 에 그 키가 1건 이상 있는지만 보면 된다.
//
//   INSERT 전부          PK 가 k6 생성값                      kind = 'insert'
//   status_change        status='PENDING' 가드, PK 당 1회      kind = 결과 status
//   refund               status='SUCCESS' 가드, 결과 REFUND    kind = 'REFUND'
//   product_soft_delete  deleted_at IS NULL 가드, PK 당 1회    kind = 'soft_delete'
//
// transactions 는 한 PK 에 UPDATE 가 두 번(상태 변경, 환불) 올 수 있지만 after.status 가
// 다르므로 kind 로 갈린다. 시간 컬럼이 키에 없으니 정밀도도, 타입 변환도 문제가 안 된다.
//
// grade_change 와 product_update(이름/가격) 는 한 PK 가 반복 변경되는 경로라 여기 없다.
// database/sql 의 조용한 재시도가 같은 PK 에 두 번째 이벤트를 만들 수 있고, 그러면
// S3 의 어떤 이벤트가 k6 의 어떤 기록에 대응하는지 구별할 수 없다. 감사 부하는 이 둘을 돌리지 않는다.
//
// [k6 ~ PostgreSQL 구간의 에러는 감사와 무관하다]
// 에러가 나면 k6 는 기록하지 않고, 기록하지 않은 이벤트는 검증 대상이 아니다. 재시도의 두 번째
// 실행은 가드에 막혀 0건이거나 다른 PK 를 고르므로 이미 기록된 키에 영향을 주지 못한다.
// 즉 "k6 가 기록한 모든 키가 S3 에 있다" 는 단방향 포함 검사는 에러 수와 독립이다.
//
// [출력 경로]
// console.log 는 k6 의 로거를 타고, --console-output 으로 지정한 파일에 쓰인다.
// 그 파일에는 setup() 의 로그 같은 비 JSON 줄도 섞이므로 모든 감사 줄에 PREFIX 를 붙인다.
//
// [왜 iteration 단위로 모았다 쓰는가]
// k6 에는 VU 종료 훅이 없다. 여러 iteration 에 걸쳐 버퍼링하면 테스트가 끝날 때 남은 버퍼가
// 사라지고, 그건 k6 가 기록했어야 할 키의 유실이다. 다만 방향이 "k6 과소" 라 유실 오탐은
// 아니고 검증 범위만 줄어든다. 그래도 iteration 안에서만 모으면 그 구간이 아예 없다.
//
// [한 번의 console.log 로 여러 줄을 쓴다]
// 로거는 로그 엔트리 하나를 한 번의 Write 로 내보낸다. 줄바꿈을 품은 메시지 하나는 원자적이라
// VU 가 여러 개여도 줄이 섞이지 않는다.

export const PREFIX = '@@';

let enabled = false;
let lines = [];

export function enable() {
    enabled = true;
}

// 키는 runSql 의 op 인자와 정확히 같아야 한다. 결제 생성의 오염 변형은 insertPayment 가
// `dq_${corruption}` 으로 조립하므로 dq_negative / dq_mismatch 다 (시나리오 이름과 다르다).
//
// kind 가 문자열이면 상수, { column } 이면 그 RETURNING 컬럼 값을 쓴다.
// parent 는 결제 생성 전용이다. 한 문장이 transaction_items 와 transactions 양쪽에
// 행을 만들므로 CDC 이벤트도 두 토픽에 생긴다. 둘 다 세야 둘 다 검증된다.
const SHAPES = {
    new_payment: { table: 'transaction_items', pk: 'item_id', kind: 'insert', parent: 'transaction_id' },
    dq_negative: { table: 'transaction_items', pk: 'item_id', kind: 'insert', parent: 'transaction_id' },
    dq_mismatch: { table: 'transaction_items', pk: 'item_id', kind: 'insert', parent: 'transaction_id' },
    product_insert: { table: 'products', pk: 'product_id', kind: 'insert' },
    status_change: { table: 'transactions', pk: 'transaction_id', kind: { column: 'status' } },
    refund: { table: 'transactions', pk: 'transaction_id', kind: { column: 'status' } },
    product_soft_delete: { table: 'products', pk: 'product_id', kind: 'soft_delete' },
};

function emit(table, pk, kind) {
    lines.push(PREFIX + JSON.stringify({ t: table, k: String(pk), e: String(kind) }));
}

// runSql 이 성공한 뒤 호출한다. rows 는 RETURNING 결과이고, 길이가 0 이면 변경이 없었다는 뜻이라
// CDC 이벤트도 생기지 않는다.
export function record(op, rows) {
    if (!enabled || rows === null || rows.length === 0) {
        return;
    }
    const shape = SHAPES[op];
    if (shape === undefined) {
        // 감사 대상이 아닌 트래픽이 감사 부하에 섞였다. 조용히 넘기면 검증 범위가 줄어든 채
        // PASS 가 찍히므로 여기서 멈춘다. cdc_audit.js 의 가중치/핸들러를 확인할 것.
        throw new Error(`audit: op '${op}' is not auditable (no unique-per-pk guarantee)`);
    }

    for (const row of rows) {
        const kind = typeof shape.kind === 'string' ? shape.kind : row[shape.kind.column];
        emit(shape.table, row[shape.pk], kind);
    }

    // 품목이 여러 개여도 결제는 하나다.
    if (shape.parent !== undefined) {
        emit('transactions', rows[0][shape.parent], 'insert');
    }
}

export function flush() {
    if (lines.length === 0) {
        return;
    }
    console.log(lines.join('\n'));
    lines = [];
}
