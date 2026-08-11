import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";

import type {
  MaxApiComment,
  MaxApiPost,
  MaxChatAdmin,
  MaxClient,
  MaxDeleteMessageInput,
  MaxEngagementChannelRecord,
  MaxPublishCommentInput,
  MaxPublishCommentResult,
  MaxSendChatMessageInput,
  MaxSendChatMessageResult
} from "./types.js";

export function createMaxClientFromEnv(): MaxClient {
  const mode = process.env.MAX_API_MODE || "mock";
  if (mode === "mock") {
    return new MockMaxClient();
  }

  return new HttpMaxClient({
    baseUrl: process.env.MAX_API_BASE_URL,
    caFile: process.env.MAX_API_CA_FILE,
    token: process.env.MAX_API_TOKEN,
    requestTimeoutMs: Number(process.env.MAX_API_REQUEST_TIMEOUT_MS || 0)
  });
}

export class MockMaxClient implements MaxClient {
  async fetchPosts(channel: MaxEngagementChannelRecord): Promise<MaxApiPost[]> {
    return [
      {
        id: `${channel.maxChannelId}:mock-post-1`,
        channelId: channel.maxChannelId,
        url: `max://channels/${channel.maxChannelId}/posts/mock-post-1`,
        authorName: "Администратор",
        text:
          channel.channelKind === "news"
            ? "Во Владивостоке сегодня открыли новую детскую площадку во дворе."
            : "Мамочки, как вы укладываете детей спать летом, когда дома жарко?",
        postedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        commentsCount: 2,
        reactionsCount: 5
      }
    ];
  }

  async fetchComments(channel: MaxEngagementChannelRecord, post: MaxApiPost): Promise<MaxApiComment[]> {
    return [
      {
        id: `${post.id}:mock-comment-1`,
        postId: post.id,
        threadId: `${post.id}:thread`,
        authorUserId: "mock-user-1",
        authorName: "Анна",
        text: channel.channelKind === "news" ? "Наконец-то хорошие новости, а не вечные жалобы." : "А если днем вообще не спит, это нормально?",
        postedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString()
      },
      {
        id: `${post.id}:mock-comment-2`,
        postId: post.id,
        threadId: `${post.id}:thread`,
        authorUserId: "mock-user-2",
        authorName: "Мария",
        text: "У нас помогает проветрить комнату и убрать лишний свет.",
        postedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
      }
    ];
  }

  async publishComment(input: MaxPublishCommentInput): Promise<MaxPublishCommentResult> {
    return {
      commentId: `mock-published:${input.postId}:${Date.now()}`
    };
  }

  async deleteOwnComment(): Promise<void> {
    return;
  }

  async deleteChatMessage(): Promise<void> {
    return;
  }

  async listChatAdmins(): Promise<MaxChatAdmin[]> {
    return [];
  }

  async sendChatMessage(input: MaxSendChatMessageInput): Promise<MaxSendChatMessageResult> {
    return { messageId: `mock-chat:${input.chatId}:${Date.now()}` };
  }
}

class HttpMaxClient implements MaxClient {
  constructor(private readonly config: { baseUrl?: string; caFile?: string; token?: string; requestTimeoutMs?: number }) {}

  async fetchPosts(): Promise<MaxApiPost[]> {
    throw new Error("MAX real post/comment ingestion is event-driven; use Webhook or Long Polling updates instead of fetchPosts");
  }

  async fetchComments(): Promise<MaxApiComment[]> {
    throw new Error("MAX real post/comment ingestion is event-driven; use Webhook or Long Polling updates instead of fetchComments");
  }

  async publishComment(input: MaxPublishCommentInput): Promise<MaxPublishCommentResult> {
    const message = await this.request<{ body?: { mid?: string }; id?: string; message_id?: string }>(
      "POST",
      `/messages?chat_id=${encodeURIComponent(input.channelId)}`,
      {
        text: input.text,
        link: {
          type: "reply",
          mid: input.postId
        }
      }
    );

    const commentId = message.body?.mid ?? message.message_id ?? message.id;
    return {
      commentId: commentId ? String(commentId) : `max-message:${Date.now()}`
    };
  }

  async deleteOwnComment(): Promise<void> {
    throw new Error("MAX deleteOwnComment needs the real message id mapping and must be enabled only after live posting is approved");
  }

  async deleteChatMessage(input: MaxDeleteMessageInput): Promise<void> {
    const result = await this.request<{ success?: boolean; message?: string }>(
      "DELETE",
      `/messages?message_id=${encodeURIComponent(input.messageId)}`
    );

    if (result.success === false) {
      throw new Error(`MAX message delete failed: ${result.message || "success=false"}`);
    }
  }

  async listChatAdmins(chatId: string): Promise<MaxChatAdmin[]> {
    const result = await this.request<{ members?: unknown[] }>(
      "GET",
      `/chats/${encodeURIComponent(chatId)}/members/admins`
    );

    return (Array.isArray(result.members) ? result.members : []).map(mapChatAdmin);
  }

  async sendChatMessage(input: MaxSendChatMessageInput): Promise<MaxSendChatMessageResult> {
    const payload: Record<string, unknown> = { text: input.text };
    if (input.attachments && input.attachments.length > 0) {
      payload.attachments = input.attachments;
    }
    if (input.replyToMessageId) {
      payload.link = { type: "reply", mid: input.replyToMessageId };
    }
    const message = await this.request<{ body?: { mid?: string }; id?: string; message_id?: string }>(
      "POST",
      `/messages?chat_id=${encodeURIComponent(input.chatId)}`,
      payload
    );
    const messageId = message.body?.mid ?? message.message_id ?? message.id;
    return { messageId: messageId ? String(messageId) : `max-message:${Date.now()}` };
  }

  private async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const baseUrl = this.config.baseUrl || "https://platform-api2.max.ru";
    if (!this.config.token) {
      throw new Error("MAX_API_TOKEN is required for MAX_API_MODE=http");
    }

    const text = await this.requestText(new URL(path, baseUrl), method, body);
    return JSON.parse(text) as T;
  }

  private async requestText(url: URL, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<string> {
    if (!this.config.token) {
      throw new Error("MAX_API_TOKEN is required for MAX_API_MODE=http");
    }

    const caFile = resolveCaFile(this.config.caFile);
    const ca = caFile ? await readFile(caFile, "utf8") : undefined;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const timeoutMs = Math.max(
      Number(this.config.requestTimeoutMs ?? process.env.MAX_API_REQUEST_TIMEOUT_MS ?? 0),
      30_000
    );

    return await new Promise((resolve, reject) => {
      const req = httpsRequest(url, {
        method,
        headers: {
          Authorization: this.config.token,
          ...(payload === undefined ? {} : {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          })
        },
        ca
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`MAX API ${method} ${url.pathname} failed with ${res.statusCode ?? 0}: ${text}`));
            return;
          }

          resolve(text);
        });
      });

      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`MAX API ${method} ${url.pathname} timed out after ${timeoutMs}ms`));
      });
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }
}

function mapChatAdmin(value: unknown): MaxChatAdmin {
  const row = (value && typeof value === "object") ? value as Record<string, unknown> : {};
  const userId =
    row.user_id ??
    row.id ??
    (row.user && typeof row.user === "object" ? (row.user as Record<string, unknown>).user_id : undefined);

  return {
    userId: userId === undefined || userId === null ? null : String(userId),
    isAdmin: row.is_admin !== false,
    isOwner: Boolean(row.is_owner),
    isBot: Boolean(row.is_bot),
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : []
  };
}

function resolveCaFile(configured?: string): string | undefined {
  if (configured && existsSync(configured)) {
    return configured;
  }

  const fallback = resolve(".local-data/certs/max-api-ca-bundle.pem");
  return existsSync(fallback) ? fallback : configured;
}
