export function randInt(minInclusive, maxInclusive) {
    return minInclusive + Math.floor(Math.random() * (maxInclusive - minInclusive + 1));
}

export function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
}

export function percent(threshold) {
    return Math.random() * 100 < threshold;
}

// { key: weight } 를 누적 구간으로 펼쳐 둔다. 매 iteration 마다 다시 계산하지 않기 위함.
export function buildWeightedPicker(weightMap) {
    const keys = [];
    const cumulative = [];
    let total = 0;

    for (const key of Object.keys(weightMap)) {
        const weight = weightMap[key];
        if (weight <= 0) {
            continue;
        }
        total += weight;
        keys.push(key);
        cumulative.push(total);
    }

    if (total <= 0) {
        throw new Error('all scenario weights are zero');
    }

    return function pickWeighted() {
        const target = Math.random() * total;
        for (let i = 0; i < cumulative.length; i += 1) {
            if (target < cumulative[i]) {
                return keys[i];
            }
        }
        return keys[keys.length - 1];
    };
}

// 우리가 생성한 값만 인라인하지만, 문자열은 예외 없이 이스케이프해서 넣는다.
export function quote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}
