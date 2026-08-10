import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { LocalEngagementRepository } from "./local-repository.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("contact directory ingestion", () => {
  it("keeps an attachment-only MAX chat message instead of dropping it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "max-contact-directory-"));
    tempDirs.push(dir);
    const repository = new LocalEngagementRepository(join(dir, "data.json"));
    await repository.resetDemoData();
    const chatId = -77530014639999;

    const result = await repository.importMaxUpdates([{
      update_type: "message_created",
      timestamp: 1_800_000_100_000,
      chat_id: chatId,
      message: {
        sender: { user_id: 778, first_name: "Анна", is_bot: false },
        recipient: { chat_id: chatId, chat_type: "chat" },
        timestamp: 1_800_000_100_000,
        body: {
          mid: "contact-only-mid",
          text: null,
          attachments: [{ type: "contact", name: "Сергей", phone: "+7 900 000-00-00" }]
        }
      }
    }]);

    const data = await repository.read();
    const channel = data.channels.find((item) => item.maxChannelId === String(chatId));
    const messages = await repository.listUnprocessedChatMessages(channel!.id);

    expect(result.messages).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("");
    expect(messages[0].rawAttachments).toEqual([
      { type: "contact", name: "Сергей", phone: "+7 900 000-00-00" }
    ]);
  });
});
