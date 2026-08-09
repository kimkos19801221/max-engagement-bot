import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

import { createEngagementRepositoryFromEnv } from "./max-engagement/repository-factory.js";
import { createMaxUpdatesClientFromEnv } from "./max-engagement/max-updates-client.js";
import { syncRecentChannelMessages, type MaxHistorySyncResult } from "./max-history.js";
import { runDryRunWorker } from "./worker.js";

loadDotenv({ path: ".env.local", override: false });

type MaxPollResult = {
  markerBefore: number | null;
  markerAfter: number | null;
  updates: {
    received: number;
    imported: number;
    channels: number;
    messages: number;
    skipped: number;
  };
  history: MaxHistorySyncResult;
  worker: Awaited<ReturnType<typeof runDryRunWorker>>;
};

let repository: ReturnType<typeof createEngagementRepositoryFromEnv> | null = null;
let client: ReturnType<typeof createMaxUpdatesClientFromEnv> | null = null;

const loopMode = process.argv.includes("--loop");
const idleDelayMs = Math.max(
  250,
  Number(process.env.MAX_POLL_IDLE_DELAY_MS || 1000)
);
const errorDelayMs = Math.max(
  1000,
  Number(process.env.MAX_POLL_ERROR_DELAY_MS || 5000)
);
const pollWatchdogMs = Math.max(
  30_000,
  Number(
    process.env.MAX_POLL_WATCHDOG_MS ||
      (Number(process.env.MAX_UPDATES_TIMEOUT || (loopMode ? 25 : 0)) * 1000 + 90_000)
  )
);
const heartbeatPath = resolve(
  process.env.MAX_POLL_HEARTBEAT_FILE || ".local-data/runtime/max-poll-heartbeat.json"
);

let stopping = false;
let consecutiveErrors = 0;

class WatchdogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchdogError";
  }
}

process.on("SIGINT", () => {
  stopping = true;
  console.log("\nОстанавливаю постоянный polling...");
});

process.on("SIGTERM", () => {
  stopping = true;
});

if (loopMode) {
  console.log("MAX polling запущен постоянно. Для остановки нажмите Ctrl+C.");

  while (!stopping) {
    try {
      const result = await withWatchdog(pollOnce(), pollWatchdogMs, "MAX poll iteration");
      consecutiveErrors = 0;
      await writeHeartbeat("ok", { result });
      console.log(JSON.stringify(result, null, 2));

      if (!stopping) {
        await delay(idleDelayMs);
      }
    } catch (error) {
      consecutiveErrors += 1;
      await writeHeartbeat("error", {
        consecutiveErrors,
        error: sanitizeError(formatError(error))
      });
      console.error(sanitizeError(formatError(error)));

      if (error instanceof WatchdogError) {
        process.exit(1);
      }

      if (!stopping) {
        console.error(`Повторная попытка через ${errorDelayMs} мс...`);
        await delay(errorDelayMs);
      }
    }
  }

  console.log("MAX polling остановлен.");
} else {
  try {
    const result = await withWatchdog(pollOnce(), pollWatchdogMs, "MAX poll iteration");
    await writeHeartbeat("ok", { result });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await writeHeartbeat("error", { error: sanitizeError(formatError(error)) });
    console.error(sanitizeError(formatError(error)));
    process.exitCode = 1;
  }
}

async function pollOnce(): Promise<MaxPollResult> {
  const currentRepository = getRepository();
  const currentClient = getClient();
  console.log(`[max-poll] step=get_marker at=${new Date().toISOString()}`);
  const markerBefore = await currentRepository.getMaxPollingMarker();
  console.log(`[max-poll] step=get_updates marker=${markerBefore ?? "null"} at=${new Date().toISOString()}`);
  const response = await currentClient.getUpdates({
    marker: markerBefore,
    limit: Number(process.env.MAX_UPDATES_LIMIT || 100),
    timeout: Number(
      process.env.MAX_UPDATES_TIMEOUT || (loopMode ? 25 : 0)
    ),
    types: [
      "bot_added",
      "message_created",
      "message_edited",
      "message_removed"
    ]
  });

  console.log(`[max-poll] step=import_updates received=${response.updates.length} at=${new Date().toISOString()}`);
  const updates = await currentRepository.importMaxUpdates(response.updates);

  const history = process.env.ENGAGEMENT_STORAGE === "supabase"
    ? { channels: 0, fetched: 0, posts: 0, skipped: 0 }
    : await syncRecentChannelMessages(
        currentRepository as import("./max-engagement/local-repository.js").LocalEngagementRepository,
        {
          limit: Number(process.env.MAX_HISTORY_LIMIT || 20)
        }
      );

  console.log(`[max-poll] step=worker at=${new Date().toISOString()}`);
  const worker = await runDryRunWorker(currentRepository);
  await currentRepository.setMaxPollingMarker(response.marker);

  return {
    markerBefore,
    markerAfter: response.marker,
    updates,
    history,
    worker
  };
}

function getRepository(): ReturnType<typeof createEngagementRepositoryFromEnv> {
  repository ??= createEngagementRepositoryFromEnv();
  return repository;
}

function getClient(): ReturnType<typeof createMaxUpdatesClientFromEnv> {
  client ??= createMaxUpdatesClientFromEnv();
  return client;
}

async function withWatchdog<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new WatchdogError(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function writeHeartbeat(
  status: "ok" | "error",
  details: Record<string, unknown>
): Promise<void> {
  try {
    await mkdir(dirname(heartbeatPath), { recursive: true });
    await writeFile(
      heartbeatPath,
      `${JSON.stringify(
        {
          status,
          at: new Date().toISOString(),
          pid: process.pid,
          loopMode,
          consecutiveErrors,
          ...details
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  } catch (error) {
    console.error(`[max-poll] heartbeat_write_failed: ${sanitizeError(formatError(error))}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error ? `; cause: ${error.cause.message}` : "";

    return `${error.name}: ${error.message}${cause}\n${error.stack ?? ""}`;
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }

  return String(error);
}

function sanitizeError(message: string): string {
  const token = process.env.MAX_API_TOKEN;

  if (!token) {
    return message;
  }

  return message.replaceAll(token, "[MAX_API_TOKEN]");
}
