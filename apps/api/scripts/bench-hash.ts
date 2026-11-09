import { hashPassword, verifyPassword } from "../src/password";

// Mede o custo do scrypt neste ambiente (Node). NÃO representa o runtime de Workers (KI-005).
for (const logN of [14, 15, 16]) {
  const t0 = performance.now();
  const h = await hashPassword("benchmark-password-Xy9!", logN);
  const t1 = performance.now();
  await verifyPassword("benchmark-password-Xy9!", h, logN);
  const t2 = performance.now();
  console.log(`logN=${logN} (${(2 ** logN * 128) / 1024 / 1024} MiB): hash ${(t1 - t0).toFixed(0)} ms, verify ${(t2 - t1).toFixed(0)} ms`);
}
