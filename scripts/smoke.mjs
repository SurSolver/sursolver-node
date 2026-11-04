// Live smoke test against the real API. Costs nothing: it reads the public catalog and calls
// getBalance with a fake key (expects AuthenticationError). Set SURSOLVER_API_KEY to also read
// your real balance. Run after `npm run build`.
import { AuthenticationError, SurSolver } from '../dist/esm/index.js';

const FAKE_KEY = 'sur_00000000000000000000000000000000';
const baseUrl = process.env.SURSOLVER_BASE_URL ?? 'https://api.sursolver.com';

const client = new SurSolver(FAKE_KEY, { baseUrl });
const catalog = await client.listTaskTypes();
console.log(`listTaskTypes: ${catalog.taskTypes.length} types, ${catalog.errorCodes.length} error codes`);
const services = await client.listServices();
console.log(`listServices: ${services.length} active services`);

try {
  await client.getBalance();
  throw new Error('getBalance with a fake key unexpectedly succeeded');
} catch (error) {
  if (!(error instanceof AuthenticationError)) throw error;
  console.log(`getBalance (fake key): ${error.name} ${error.code}`);
}

const realKey = process.env.SURSOLVER_API_KEY;
if (realKey !== undefined && realKey !== '') {
  console.log(`getBalance (your key): ${await new SurSolver(realKey, { baseUrl }).getBalance()} USD`);
}
console.log('smoke: OK');
