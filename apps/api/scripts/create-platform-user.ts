import { loadConfig } from "../src/config";
import { Db } from "../src/db";
import { hashPassword } from "../src/password";
import { validatePassword } from "@autoflow/shared";

// Uso: PLATFORM_EMAIL=... PLATFORM_PASSWORD=... pnpm db:create-platform-user
const email = process.env.PLATFORM_EMAIL?.trim().toLowerCase();
const password = process.env.PLATFORM_PASSWORD;
if (!email || !password) throw new Error("Defina PLATFORM_EMAIL e PLATFORM_PASSWORD");
const problem = validatePassword(password, email);
if (problem) throw new Error(`Senha fraca: ${problem}`);
const config = loadConfig();
const db = new Db(config.databaseUrl, 1);
const hash = await hashPassword(password, config.scryptLogN);
await db.system((q) => q.query("insert into platform_users (email, password_hash) values ($1,$2)", [email, hash]));
await db.close();
console.log("Super Admin criado (MFA será exigido no primeiro login).");
