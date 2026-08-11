import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

import { telegramUpdatesToUnified } from "./chat-transport/telegram-adapter.js";
import { createEngagementRepositoryFromEnv } from "./max-engagement/repository-factory.js";
import { createTelegramClientFromEnv } from "./telegram-client.js";
import { runChatWorker } from "./worker.js";

loadDotenv({ path: ".env.local", override: false });

const loopMode = process.argv.includes("--loop");
const offsetPath = resolve(process.env.TELEGRAM_POLL_OFFSET_FILE || ".local-data/runtime/telegram-poll-offset.json");
const heartbeatPath = resolve(process.env.TELEGRAM_POLL_HEARTBEAT_FILE || ".local-data/runtime/telegram-poll-heartbeat.json");
const idleDelayMs = Math.max(250, Number(process.env.TELEGRAM_POLL_IDLE_DELAY_MS || 1000));
const errorDelayMs = Math.max(1000, Number(process.env.TELEGRAM_POLL_ERROR_DELAY_MS || 5000));
const longPollTimeout = Math.max(0, Number(process.env.TELEGRAM_UPDATES_TIMEOUT || (loopMode ? 25 : 0)));

let stopping = false;
let consecutiveErrors = 0;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

if (loopMode) {
  console.log("Telegram polling запущен постоянно. Для остановки нажмите Ctrl+C.");
  while (!stopping) {
    try {
      const result = await pollOnce();
      consecutiveErrors = 0;
      await writeHeartbeat("ok", { result });
      console.log(JSON.stringify(result, null, 2));
      if (!stopping) await delay(idleDelayMs);
    } catch (error) {
      consecutiveErrors += 1;
      const message = formatError(error);
      await writeHeartbeat("error", { consecutiveErrors, error: sanitizeError(message) });
      console.error(sanitizeError(message));
      if (!stopping) await delay(errorDelayMs);
    }
  }
} else {
  try {
    const result = await pollOnce();
    await writeHeartbeat("ok", { result });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeHeartbeat("error", { error: sanitizeError(formatError(error)) });
    console.error(sanitizeError(formatError(error)));
    process.exitCode = 1;
  }
}

async function pollOnce() {
  const repository = createEngagementRepositoryFromEnv();
  const client = createTelegramClientFromEnv();
  const offsetBefore = await readOffset();
  console.log(`[telegram-poll] step=get_updates offset=${offsetBefore ?? "null"} at=${new Date().toISOString()}`);
  const updates = await client.getUpdates({
    offset: offsetBefore,
    limit: Number(process.env.TELEGRAM_UPDATES_LIMIT || 100),
    timeout: longPollTimeout,
    allowedUpdates: ["message"]
  });

  const messages = telegramUpdatesToUnified(updates);
  console.log(`[telegram-poll] step=import_messages updates=${updates.length} messages=${messages.length} at=${new Date().toISOString()}`);
  const imported = await repository.importChatMessages(messages);
  const worker = await runChatWorker(repository, client, "telegram");

  const offsetAfter = updates.length > 0
    ? Math.max(...updates.map((update) => update.update_id)) + 1
    : offsetBefore;
  if (offsetAfter !== null) await writeOffset(offsetAfter);

  return { offsetBefore, offsetAfter, updatesReceived: updates.length, imported, worker };
}

async function readOffset(): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(offsetPath, "utf8")) as { offset?: unknown };
    return typeof parsed.offset === "number" && Number.isSafeInteger(parsed.offset) ? parsed.offset : null;
  } catch {
    return null;
  }
}

async function writeOffset(offset: number): Promise<void> {
  await mkdir(dirname(offsetPath), { recursive: true });
  await writeFile(offsetPath, `${JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function writeHeartbeat(status: "ok" | "error", details: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(heartbeatPath), { recursive: true });
    await writeFile(heartbeatPath, `${JSON.stringify({ status, at: new Date().toISOString(), pid: process.pid, loopMode, ...details }, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error(`[telegram-poll] heartbeat_write_failed: ${sanitizeError(formatError(error))}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
}

function sanitizeError(message: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? message.replaceAll(token, "[TELEGRAM_BOT_TOKEN]") : message;
}
