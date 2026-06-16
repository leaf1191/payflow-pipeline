import sql from 'k6/x/sql';
import driver from 'k6/x/sql/driver/postgres';
import { check, sleep } from 'k6';

const connectionString = [
  `postgres://${__ENV.POSTGRES_USER}:${__ENV.POSTGRES_PASSWORD}`,
  `@${__ENV.POSTGRES_HOST}:${__ENV.POSTGRES_PORT || '5432'}`,
  `/${__ENV.POSTGRES_DB}?sslmode=disable`,
].join('');

const db = sql.open(driver, connectionString);

const GRADES = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];
const USER_IDS = [1, 2, 3];

export const options = {
  vus: Number(__ENV.VUS || 3),
  duration: __ENV.DURATION || '30s',
};

export default function () {
  const userId = USER_IDS[Math.floor(Math.random() * USER_IDS.length)];
  const grade = GRADES[Math.floor(Math.random() * GRADES.length)];

  const result = sql.exec(
    db,
    `
      UPDATE users
      SET grade = $1, updated_at = NOW()
      WHERE user_id = $2 AND deleted_at IS NULL
    `,
    grade,
    userId,
  );

  check(result, {
    'grade update applied': (r) => r.rowsAffected === 1,
  });

  sleep(0.5);
}

export function teardown() {
  db.close();
}
