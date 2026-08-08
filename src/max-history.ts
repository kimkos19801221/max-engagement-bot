import "dotenv/config";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import type { LocalEngagementRepository } from "./max-engagement/local-repository.js";
import { LocalEngagementRepository as DefaultLocalEngagementRepository } from "./max-engagement/local-repository.js";
import type { MaxApiPost, MaxEngagementChannelRecord } from "./max-engagement/types.js";
import { runDryRunWorker } from "./worker.js";

loadDotenv({ path: ".env.local", override: false });

type MaxMessage = {
  recipient?: {
    chat_id?: number | string;
    chat_type?: string;
  };
  timestamp?: number;
  body?: {
    mid?: string;
    text?: string;
  };
  stat?: {
    comments?: number;
    reactions?: number;
    likes?: number;
    views?: number;
  };
  link?: {
    type?: string;
    message?: {
      mid?: string;
    };
  };
  url?: string;
};

type MaxMessagesResponse = {
  messages?: MaxMessage[];
};

export type MaxHistorySyncResult = {
  channels: number;
  fetched: number;
  posts: number;
  skipped: number;
};

export async function syncRecentChannelMessages(
  repository: LocalEngagementRepository,
  options: { limit?: number } = {}
): Promise<MaxHistorySyncResult> {
  const result: MaxHistorySyncResult = {
    channels: 0,
    fetched: 0,
    posts: 0,
    skipped: 0
  };

  const channels = (await repository.listChannels())
    .filter((channel) => /^-?\d+$/.test(channel.maxChannelId));

  for (const channel of channels) {
    result.channels += 1;
    const messages = await getMessages(channel.maxChannelId, options.limit ?? 20);
    result.fetched += messages.length;

    for (const message of messages) {
      const post = toPost(channel, message);
      if (!post) {
        result.skipped += 1;
        continue;
      }

      const saved = await repository.upsertMaxPost(channel, post);
      await repository.upsertMaxThread(channel.id, saved.id, post.id);
      result.posts += 1;
    }
  }

  return result;
}

async function getMessages(chatId: string, limit: number): Promise<MaxMessage[]> {
  const url = new URL("/messages", process.env.MAX_API_BASE_URL || "https://platform-api2.max.ru");
  url.searchParams.set("chat_id", chatId);
  url.searchParams.set("count", String(limit));

  const response = await requestJson<MaxMessagesResponse>(url);
  return Array.isArray(response.messages) ? response.messages : [];
}

async function requestJson<T>(url: URL): Promise<T> {
  const token = process.env.MAX_API_TOKEN;
  if (!token) {
    throw new Error("MAX_API_TOKEN is required");
  }

  const caFile = resolveCaFile();
  const ca = caFile ? await readFile(caFile, "utf8") : undefined;

  return await new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "GET",
      headers: {
        Authorization: token
      },
      ca
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`MAX API GET ${url.pathname} failed with ${res.statusCode ?? 0}: ${text}`));
          return;
        }

        resolve(JSON.parse(text) as T);
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function toPost(channel: MaxEngagementChannelRecord, message: MaxMessage): MaxApiPost | null {
  if (message.link) {
    return null;
  }

  const id = message.body?.mid;
  const text = message.body?.text?.trim();
  if (!id || !text) {
    return null;
  }

  const post: MaxApiPost = {
    id,
    channelId: channel.maxChannelId,
    text,
    commentsCount: message.stat?.comments ?? 0
  };

  if (message.url) {
    post.url = message.url;
  }

  if (typeof message.timestamp === "number") {
    post.postedAt = new Date(message.timestamp).toISOString();
  }

  const reactionsCount = message.stat?.reactions ?? message.stat?.likes;
  if (typeof reactionsCount === "number") {
    post.reactionsCount = reactionsCount;
  }

  return post;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = new DefaultLocalEngagementRepository();
  try {
    const history = await syncRecentChannelMessages(repository, {
      limit: Number(process.env.MAX_HISTORY_LIMIT || 20)
    });
    const worker = await runDryRunWorker(repository);
    console.log(JSON.stringify({ history, worker }, null, 2));
  } catch (error) {
    console.error(sanitizeError(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

function sanitizeError(message: string): string {
  const token = process.env.MAX_API_TOKEN;
  if (!token) {
    return message;
  }

  return message.replaceAll(token, "[MAX_API_TOKEN]");
}

function resolveCaFile(): string | undefined {
  const configured = process.env.MAX_API_CA_FILE;
  if (configured && existsSync(configured)) {
    return configured;
  }

  const fallback = resolve(".local-data/certs/max-api-ca-bundle.pem");
  return existsSync(fallback) ? fallback : configured;
}
