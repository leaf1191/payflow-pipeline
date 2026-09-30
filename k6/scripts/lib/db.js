import { Counter } from 'k6/metrics';
import sql from 'k6/x/sql';
import driver from 'k6/x/sql/driver/postgres';

import { connectionString } from './config.js';

// init 컨텍스트에서 VU 당 하나씩 열린다. database/sql 풀이므로 실제 연결은 지연 생성되고,
// VU 는 한 번에 한 문장만 실행하므로 VU 당 물리 커넥션은 1개로 수렴한다.
export const db = sql.open(driver, connectionString());

// 부하 발생기 자체가 고장났는지만 본다.
// 처리량·지연은 postgres_exporter 실측값(Grafana)이 정답이고,
// 정합성·멱등성은 DB 와 S3 의 실제 데이터로만 판정한다.
const sqlErrors = new Counter('sql_errors');

let loggedErrors = 0;
const ERROR_LOG_LIMIT = 20;

// 모든 DML 은 RETURNING 을 달아 query() 로 실행한다.
// 드라이버별로 제각각인 rowsAffected 대신 결과 row 로 "실제로 바뀐 행"을 확인한다.
// 반환값: row 배열, 실패 시 null.
export function runSql(op, query, args) {
    try {
        const rows = args && args.length > 0 ? db.query(query, ...args) : db.query(query);
        return rows || [];
    } catch (err) {
        sqlErrors.add(1, { op: op });
        if (loggedErrors < ERROR_LOG_LIMIT) {
            loggedErrors += 1;
            console.error(`[${op}] ${err}`);
        }
        return null;
    }
}
export function closeDb() {
    db.close();
}
