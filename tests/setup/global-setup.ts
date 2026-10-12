// Runs once before the suite: applies every migration to the dedicated TEST database,
// proving the migration history works from an empty schema.
import { execSync } from 'node:child_process';

export default function setup() {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Start the test database (docker compose up -d postgres_test) and copy .env.example to .env.');
  }
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error('Refusing to run: TEST_DATABASE_URL must point to a database whose name contains "test".');
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url },
  });
}
