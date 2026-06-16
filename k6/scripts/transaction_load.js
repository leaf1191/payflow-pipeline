import sql from 'k6/x/sql';
import driver from 'k6/x/sql/driver/postgres';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const connectionString = [
  `postgres://${__ENV.POSTGRES_USER}:${__ENV.POSTGRES_PASSWORD}`,
  `@${__ENV.POSTGRES_HOST}:${__ENV.POSTGRES_PORT || '5432'}`,
  `/${__ENV.POSTGRES_DB}?sslmode=disable`,
].join('');

const db = sql.open(driver, connectionString);

const USER_IDS = [1, 2, 3];
const STATUSES = ['PENDING', 'COMPLETED', 'FAILED'];

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const rows = sql.query(db, 'SELECT COUNT(*) AS count FROM users');
  if (!rows.length || Number(rows[0].count) === 0) {
    throw new Error('users table is empty. Start infra/postgres first.');
  }
}

export default function () {
  const userId = USER_IDS[Math.floor(Math.random() * USER_IDS.length)];
  const amount = (Math.random() * 50000 + 100).toFixed(2);
  const status = STATUSES[Math.floor(Math.random() * STATUSES.length)];
  const iterationTag = `${exec.vu.idInTest}-${exec.scenario.iterationInInstance}`;

  const result = sql.exec(
    db,
    `
      INSERT INTO transactions (user_id, amount, status)
      VALUES ($1, $2, $3)
    `,
    userId,
    amount,
    status,
  );

  check(result, {
    'insert succeeded': (r) => r.rowsAffected === 1,
    [`insert tagged ${iterationTag}`]: () => true,
  });

  sleep(0.05);
}

export function teardown() {
  db.close();
}
