import "dotenv/config";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { createEngagementRepositoryFromEnv } from "./max-engagement/repository-factory.js";

loadDotenv({ path: ".env.local", override: false });

type MaxChat = {
  chat_id?: number | string;
  title?: string;
  type?: string;
  status?: string;
  participants_count?: number;
  messages_count?: number;
};

type MaxMembership = {
  is_admin?: boolean;
  is_owner?: boolean;
  permissions?: string[];
  username?: string;
  name?: string;
};

type ApiResult<T> = {
  status: number;
  body: T | { code?: string; message?: string };
};

const repository = createEngagementRepositoryFromEnv();

try {
  const channels = (await repository.listRunnableChannels())
    .filter((channel) => /^-?\d+$/.test(channel.maxChannelId));

  const verified = [];
  for (const channel of channels) {
    const chat = await getJson<MaxChat>(`/chats/${encodeURIComponent(channel.maxChannelId)}`);
    const membership = await getJson<MaxMembership>(`/chats/${encodeURIComponent(channel.maxChannelId)}/members/me`);
    verified.push({
      localTitle: channel.title,
      maxChannelId: channel.maxChannelId,
      chat: summarizeChat(chat),
      bot: summarizeMembership(membership)
    });
  }

  console.log(JSON.stringify({
    channels: verified.length,
    verified
  }, null, 2));
} catch (error) {
  console.error(sanitizeError(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  const token = process.env.MAX_API_TOKEN;
  if (!token) {
    throw new Error("MAX_API_TOKEN is required");
  }

  const baseUrl = process.env.MAX_API_BASE_URL || "https://platform-api2.max.ru";
  const caFile = resolveCaFile();
  const ca = caFile ? await readFile(caFile, "utf8") : undefined;
  const url = new URL(path, baseUrl);

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
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(text) as T
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function summarizeChat(result: ApiResult<MaxChat>) {
  const body = result.body as MaxChat;
  return {
    status: result.status,
    title: body.title ?? null,
    type: body.type ?? null,
    state: body.status ?? null,
    participants: body.participants_count ?? null,
    messages: body.messages_count ?? null
  };
}

function summarizeMembership(result: ApiResult<MaxMembership>) {
  const body = result.body as MaxMembership;
  return {
    status: result.status,
    isAdmin: body.is_admin ?? false,
    isOwner: body.is_owner ?? false,
    permissions: body.permissions ?? [],
    username: body.username ?? null,
    name: body.name ?? null
  };
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
