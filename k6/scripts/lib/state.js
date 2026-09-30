import exec from 'k6/execution';

import { BEHAVIOR, ID_FORMAT, SOURCE } from './config.js';
import { randInt } from './random.js';

// VU 별 로컬 상태. k6 는 VU 마다 JS 런타임이 분리되므로 VU 간 경합이 없다.
// PENDING 결제만 로컬에 들고 있는다. 상태 전이 대상을 DB 에서 찾으려면
// status='PENDING' 을 훑어야 하는데, 그건 초당 수천 건 규모에서 감당이 안 된다.
// 환불은 "유저의 SUCCESS 결제", 상품은 "상인의 상품" 이라는 현실적인 경로가 있어 DB 에서 찾는다.
export function createVuState(runId) {
    const vuId = exec.vu.idInTest;
    let sequence = 0;

    function nextId(prefix) {
        sequence += 1;
        return `${prefix}_${runId}_${vuId}_${sequence}`;
    }

    return {
        runId: runId,
        vuId: vuId,
        pending: new RingBuffer(BEHAVIOR.trackedIdLimit),
        nextTransactionId: () => nextId('tx'),
        // 부하 중 생기는 상품. 시드 PK 와 섞이지 않는 이름이면 충분하다.
        nextProductId: () => nextId('pnew'),
        // 상품 변경 이벤트의 after-image 에 심을 토큰.
        // (runId, vuId, sequence) 조합이라 전역 유일이 구조적으로 보장된다.
        // CDC 이벤트 식별자가 이 값에 의존하므로 난수로 바꾸면 안 된다. 아래 productUpdate 주석 참고.
        nextRevision: () => nextId('rev'),
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

// 한 유저가 둘러보는 상인 목록(중복 제거).
export function randomMerchantIds(count) {
    const seen = {};
    const ids = [];
    for (let i = 0; i < count; i += 1) {
        const id = randomMerchantId();
        if (!seen[id]) {
            seen[id] = true;
            ids.push(id);
        }
    }
    return ids;
}
