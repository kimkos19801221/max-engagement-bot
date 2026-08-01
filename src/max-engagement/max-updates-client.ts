import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";

import type { MaxUpdate } from "./types.js";

export type MaxUpdatesResponse = {
  updates: MaxUpdate[];
  marker: number | null;
};

type FetchLike = (input: string | URL, init?: {
  method?: string;
  headers?: Record<string, string>;
}) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class MaxUpdatesClient {
  constructor(private readonly config: {
    baseUrl?: string;
    caFile?: string;
    token?: string;
    fetchFn?: FetchLike;
  }) {}

  async getUpdates(input: {
    marker?: number | null;
    limit?: number;
    timeout?: number;
    types?: string[];
  } = {}): Promise<MaxUpdatesResponse> {
    const token = this.config.token;
    if (!token) {
      throw new Error("MAX_API_TOKEN is required to poll MAX updates");
    }

    const baseUrl = this.config.baseUrl || "https://platform-api2.max.ru";
    const url = new URL("/updates", baseUrl);
    url.searchParams.set("limit", String(input.limit ?? 100));
    url.searchParams.set("timeout", String(input.timeout ?? 0));
    if (input.marker !== undefined && input.marker !== null) {
      url.searchParams.set("marker", String(input.marker));
    }
    for (const type of input.types ?? []) {
      url.searchParams.append("types", type);
    }

    const response = this.config.fetchFn
      ? await this.config.fetchFn(url, {
          method: "GET",
          headers: {
            Authorization: token
          }
        })
      : await requestText(url, token, this.config.caFile);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`MAX API GET /updates failed with ${response.status}: ${text}`);
    }

    const payload = JSON.parse(text) as Partial<MaxUpdatesResponse>;
    return {
      updates: Array.isArray(payload.updates) ? payload.updates : [],
      marker: typeof payload.marker === "number" ? payload.marker : null
    };
  }
}

export function createMaxUpdatesClientFromEnv(): MaxUpdatesClient {
  return new MaxUpdatesClient({
    baseUrl: process.env.MAX_API_BASE_URL,
    caFile: process.env.MAX_API_CA_FILE,
    token: process.env.MAX_API_TOKEN
  });
}

async function requestText(url: URL, token: string, caFile?: string): Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}> {
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
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
          status: res.statusCode ?? 0,
          async text() {
            return body;
          }
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
}
