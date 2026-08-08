import "dotenv/config";
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

const repository = createEngagementRepositoryFromEnv();
const client = createMaxUpdatesClientFromEnv();

const loopMode = process.argv.includes("--loop");
const idleDelayMs = Math.max(
  250,
  Number(process.env.MAX_POLL_IDLE_DELAY_MS || 1000)
);
const errorDelayMs = Math.max(
  1000,
  Number(process.env.MAX_POLL_ERROR_DELAY_MS || 5000)
);

let stopping = false;

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
      const result = await pollOnce();
      console.log(JSON.stringify(result, null, 2));

      if (!stopping) {
        await delay(idleDelayMs);
      }
    } catch (error) {
      console.error(sanitizeError(formatError(error)));

      if (!stopping) {
        console.error(`Повторная попытка через ${errorDelayMs} мс...`);
        await delay(errorDelayMs);
      }
    }
  }

  console.log("MAX polling остановлен.");
} else {
  try {
    const result = await pollOnce();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(sanitizeError(formatError(error)));
    process.exitCode = 1;
  }
}

async function pollOnce(): Promise<MaxPollResult> {
  const markerBefore = await repository.getMaxPollingMarker();
  const response = await client.getUpdates({
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

  const updates = await repository.importMaxUpdates(response.updates);
  await repository.setMaxPollingMarker(response.marker);

  const history = process.env.ENGAGEMENT_STORAGE === "supabase"
    ? { channels: 0, fetched: 0, posts: 0, skipped: 0 }
    : await syncRecentChannelMessages(
        repository as import("./max-engagement/local-repository.js").LocalEngagementRepository,
        {
          limit: Number(process.env.MAX_HISTORY_LIMIT || 20)
        }
      );

  const worker = await runDryRunWorker(repository);

  return {
    markerBefore,
    markerAfter: response.marker,
    updates,
    history,
    worker
  };
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