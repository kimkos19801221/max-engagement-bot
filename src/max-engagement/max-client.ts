import type {
  MaxApiComment,
  MaxApiPost,
  MaxClient,
  MaxEngagementChannelRecord,
  MaxPublishCommentInput,
  MaxPublishCommentResult
} from "./types.js";

export function createMaxClientFromEnv(): MaxClient {
  const mode = process.env.MAX_API_MODE || "mock";
  if (mode === "mock") {
    return new MockMaxClient();
  }

  return new HttpMaxClient({
    baseUrl: process.env.MAX_API_BASE_URL,
    token: process.env.MAX_API_TOKEN
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
}

class HttpMaxClient implements MaxClient {
  constructor(private readonly config: { baseUrl?: string; token?: string }) {}

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
        notify: false
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

  private async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const baseUrl = this.config.baseUrl || "https://platform-api2.max.ru";
    if (!this.config.token) {
      throw new Error("MAX_API_TOKEN is required for MAX_API_MODE=http");
    }

    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        Authorization: this.config.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`MAX API ${method} ${path} failed with ${response.status}: ${await response.text()}`);
    }

    return await response.json() as T;
  }
}
