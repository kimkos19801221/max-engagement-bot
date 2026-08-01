import "dotenv/config";
import { config as loadDotenv } from "dotenv";

import { createMaxClientFromEnv } from "./max-engagement/max-client.js";
import { MaxEngagementRepository, createSupabaseClientFromEnv } from "./max-engagement/repository.js";
import { runDryRunWorker } from "./worker.js";

loadDotenv({ path: ".env.local", override: false });

type SyncResult = {
  channels: number;
  posts: number;
  comments: number;
  worker: Awaited<ReturnType<typeof runDryRunWorker>>;
};

export async function syncMaxOnce(): Promise<SyncResult> {
  const repository = new MaxEngagementRepository(createSupabaseClientFromEnv());
  const maxClient = createMaxClientFromEnv();
  const channels = await repository.listRunnableChannels();
  const result: SyncResult = {
    channels: channels.length,
    posts: 0,
    comments: 0,
    worker: {
      channels: 0,
      comments: 0,
      actions: 0,
      skipped: 0
    }
  };

  for (const channel of channels) {
    const posts = await maxClient.fetchPosts(channel);
    result.posts += posts.length;

    for (const apiPost of posts) {
      const post = await repository.upsertMaxPost(channel, apiPost);
      const comments = await maxClient.fetchComments(channel, apiPost);
      result.comments += comments.length;

      for (const apiComment of comments) {
        const thread = await repository.upsertMaxThread(channel.id, post.id, apiComment.threadId);
        await repository.upsertMaxComment(channel.id, post.id, thread.id, apiComment);
      }
    }
  }

  result.worker = await runDryRunWorker(repository);
  return result;
}

syncMaxOnce()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
