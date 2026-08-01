import "dotenv/config";
import { config as loadDotenv } from "dotenv";

import { LocalEngagementRepository } from "./max-engagement/local-repository.js";
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

const repository = new LocalEngagementRepository();
const client = createMaxUpdatesClientFromEnv();

try {
  const markerBefore = await repository.getMaxPollingMarker();
  const response = await client.getUpdates({
    marker: markerBefore,
    limit: Number(process.env.MAX_UPDATES_LIMIT || 100),
    timeout: Number(process.env.MAX_UPDATES_TIMEOUT || 0),
    types: ["bot_added", "message_created", "message_edited", "message_removed"]
  });
  const updates = await repository.importMaxUpdates(response.updates);
  await repository.setMaxPollingMarker(response.marker);
  const history = await syncRecentChannelMessages(repository, {
    limit: Number(process.env.MAX_HISTORY_LIMIT || 20)
  });
  const worker = await runDryRunWorker(repository);

  const result: MaxPollResult = {
    markerBefore,
    markerAfter: response.marker,
    updates,
    history,
    worker
  };

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = sanitizeError(formatError(error));
  console.error(message);
  process.exitCode = 1;
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause instanceof Error ? `; cause: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

function sanitizeError(message: string): string {
  const token = process.env.MAX_API_TOKEN;
  if (!token) {
    return message;
  }

  return message.replaceAll(token, "[MAX_API_TOKEN]");
}
