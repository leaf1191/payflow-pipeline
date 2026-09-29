import exec from 'k6/execution';

import { BEHAVIOR, ID_FORMAT, SOURCE } from './config.js';
import { randInt } from './random.js';

// VU 별 로컬 상태. k6 는 VU 마다 JS 런타임이 분리되므로 VU 간 경합이 없다.
// PENDING 결제만 로컬에 들고 있는다. 상태 전이 대상을 DB 에서 찾으려면
// status='PENDING' 을 훑어야 하는데, 그건 초당 수천 건 규모에서 감당이 안 된다.
// 반대로 환불은 "유저의 SUCCESS 결제"라는 현실적인 조건이 있으므로 DB 에서 찾는다.
export function createVuState(runId) {
    const vuId = exec.vu.idInTest;
    let sequence = 0;

    return {
        runId: runId,
        vuId: vuId,
        pending: new RingBuffer(BEHAVIOR.trackedIdLimit),
        nextTransactionId: function nextTransactionId() {
            sequence += 1;
            return `tx_${runId}_${vuId}_${sequence}`;
        },
    };
}

// 오래된 항목부터 덮어쓰는 고정 크기 버퍼. 장시간 부하에서도 힙이 늘지 않는다.
function RingBuffer(capacity) {
    this.capacity = capacity;
    this.items = [];
    this.writeCursor = 0;
}

RingBuffer.prototype.push = function push(value) {
    if (this.items.length < this.capacity) {
        this.items.push(value);
        return;
    }
    this.items[this.writeCursor] = value;
    this.writeCursor = (this.writeCursor + 1) % this.capacity;
};

// 무작위 위치의 값을 꺼내고 마지막 값으로 그 자리를 메운다(O(1)).
RingBuffer.prototype.takeRandom = function takeRandom() {
    if (this.items.length === 0) {
        return null;
    }
    const index = Math.floor(Math.random() * this.items.length);
    const value = this.items[index];
    const last = this.items.pop();
    if (index < this.items.length) {
        this.items[index] = last;
    }
    if (this.writeCursor > this.items.length) {
        this.writeCursor = 0;
    }
    return value;
};

function formatId(prefix, pad, index) {
    return `${prefix}${String(index).padStart(pad, '0')}`;
}

export function randomUserId() {
    return formatId(ID_FORMAT.userPrefix, ID_FORMAT.userPad, randInt(1, SOURCE.users));
}

export function randomMerchantId() {
    return formatId(ID_FORMAT.merchantPrefix, ID_FORMAT.merchantPad, randInt(1, SOURCE.merchants));
}

// 결제 후보용. soft delete 되었거나 아직 생성되지 않은 ID 도 섞여 나온다.
// 실제 사용 가능 여부는 호출부가 SELECT 로 판별한다.
export function randomProductId() {
    return formatId(ID_FORMAT.productPrefix, ID_FORMAT.productPad, randInt(1, SOURCE.productIdMax));
}

// 신규 상품용. 시드 구간 밖의 여유 ID 를 쓰므로 조회 범위 안에 들어오고,
// 부하 중 생성된 상품도 이후 결제 후보가 된다.
export function newProductId() {
    return formatId(
        ID_FORMAT.productPrefix,
        ID_FORMAT.productPad,
        randInt(SOURCE.products + 1, SOURCE.productIdMax)
    );
}
