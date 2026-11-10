import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { Db } from "./db";
import { LocalDiskStorage, UnconfiguredStorage } from "./storage";
import { MemoryEmailProvider, UnconfiguredEmailProvider } from "./email";
import { MemoryOtpChannel, UnconfiguredOtpChannel } from "./otp";

const config = loadConfig();
const db = new Db(config.databaseUrl);
// KI-010: provedor de e-mail ainda não escolhido. Em dev, mensagens ficam em memória.
const email = config.env === "production" ? new UnconfiguredEmailProvider() : new MemoryEmailProvider();
// KI-015: R2 privado não implementado. Dev: disco local; produção falha fechada até existir adaptador.
const storage = config.env === "production" ? new UnconfiguredStorage() : new LocalDiskStorage(process.env.STORAGE_DIR ?? "/tmp/autoflow-files");
// KI-003: canal de OTP real ainda não definido. Produção falha fechada (503) até existir.
const otp = config.env === "production" ? new UnconfiguredOtpChannel() : new MemoryOtpChannel();
const { app } = createApp({ config, db, email, storage, otp });
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
if (config.logLevel !== "silent") console.log(JSON.stringify({ level: "info", msg: "api up", port }));
