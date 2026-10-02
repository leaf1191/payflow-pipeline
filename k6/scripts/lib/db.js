import { Counter } from 'k6/metrics';
import sql from 'k6/x/sql';
import driver from 'k6/x/sql/driver/postgres';

import { record } from './audit.js';
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
//
// [조용한 재시도에 대하여]
// xk6-sql 의 Database 는 *sql.DB 래퍼이고 query() 는 QueryContext 를 탄다. 드라이버가
// driver.ErrBadConn 을 돌려주면 database/sql 이 같은 문장을 최대 3회까지 다시 보낸다.
// 커밋은 됐는데 응답만 못 받은 경우에도 이 경로를 타므로, 원천에 WAL 레코드가 2개 생기고
// k6 는 1건으로 센다. 표준 라이브러리에 이 루프를 끄는 설정은 없고, 재시도가 없는
// *sql.Conn / *sql.Tx 는 xk6-sql 이 JS 로 노출하지 않는다(open/query/exec/close 뿐).
//
// 막을 수 없으므로 감사가 영향을 받지 않게 설계한다. 감사 부하는 "한 PK 에 같은 종류의
// 이벤트가 최대 1건" 인 트래픽만 돌리므로, 재시도의 두 번째 실행은 가드에 막혀 0건이거나
// 다른 PK 를 고른다. 이미 기록된 키에 두 번째 이벤트를 만들 수 없고, 에러로 끝난 문장은
// 기록되지 않아 검증 대상이 아니다. 자세한 근거는 lib/audit.js 와 README 참고.
export function runSql(op, query, args) {
    let rows;
    try {
        rows = args && args.length > 0 ? db.query(query, ...args) : db.query(query);
    } catch (err) {
        sqlErrors.add(1, { op: op });
        if (loggedErrors < ERROR_LOG_LIMIT) {
            loggedErrors += 1;
            console.error(`[${op}] ${err}`);
        }
        return null;
    }

    // try 밖에서 부른다. 기록기의 설정 오류가 SQL 실패로 둔갑해 sql_errors 에 섞이면
    // 원인을 잘못 짚게 된다. 여기서 던지면 그대로 테스트가 중단된다.
    rows = rows || [];
    record(op, rows);
    return rows;
}
export function closeDb() {
    db.close();
}
