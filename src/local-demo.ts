import { createMaxClientFromEnv } from "./max-engagement/max-client.js";
import { LocalEngagementRepository } from "./max-engagement/local-repository.js";
import { runDryRunWorker } from "./worker.js";

const command = process.argv[2] || "sync";
const repository = new LocalEngagementRepository();

if (command === "reset") {
  await repository.resetDemoData();
  console.log(JSON.stringify({ ok: true, dataFile: process.env.MAX_ENGAGEMENT_LOCAL_DATA || ".local-data/max-engagement-demo.json" }, null, 2));
} else if (command === "sync") {
  await ensureSeeded();
  const maxClient = createMaxClientFromEnv();
  const channels = await repository.listRunnableChannels();
  let postsCount = 0;
  let commentsCount = 0;

  for (const channel of channels) {
    const posts = await maxClient.fetchPosts(channel);
    postsCount += posts.length;

    for (const apiPost of posts) {
      const post = await repository.upsertMaxPost(channel, apiPost);
      const comments = await maxClient.fetchComments(channel, apiPost);
      commentsCount += comments.length;

      for (const apiComment of comments) {
        const thread = await repository.upsertMaxThread(channel.id, post.id, apiComment.threadId);
        await repository.upsertMaxComment(channel.id, post.id, thread.id, apiComment);
      }
    }
  }

  const worker = await runDryRunWorker(repository);
  console.log(JSON.stringify({ channels: channels.length, posts: postsCount, comments: commentsCount, worker }, null, 2));
} else {
  console.error("Use: npm run demo:reset or npm run demo:sync");
  process.exitCode = 1;
}

async function ensureSeeded(): Promise<void> {
  await repository.read();
}
