import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { Db } from "./db";
import { MemoryEmailProvider, UnconfiguredEmailProvider } from "./email";

const config = loadConfig();
const db = new Db(config.databaseUrl);
// KI-010: provedor de e-mail ainda não escolhido. Em dev, mensagens ficam em memória.
const email = config.env === "production" ? new UnconfiguredEmailProvider() : new MemoryEmailProvider();
const { app } = createApp({ config, db, email });
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
if (config.logLevel !== "silent") console.log(JSON.stringify({ level: "info", msg: "api up", port }));
