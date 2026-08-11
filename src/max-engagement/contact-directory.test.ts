import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { LocalEngagementRepository } from "./local-repository.js";
import { buildMaxContactAttachments } from "./contact-directory.js";

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

  it("finds saved contacts by service aliases within the current chat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "max-contact-directory-"));
    tempDirs.push(dir);
    const repository = new LocalEngagementRepository(join(dir, "data.json"));
    await repository.resetDemoData();
    const chatId = -77530014639998;

    await repository.importMaxUpdates([{
      update_type: "message_created",
      timestamp: 1_800_000_100_000,
      chat_id: chatId,
      message: {
        sender: { user_id: 778, first_name: "Анна", is_bot: false },
        recipient: { chat_id: chatId, chat_type: "chat" },
        timestamp: 1_800_000_100_000,
        body: {
          mid: "contact-mid",
          text: null,
          attachments: [{ type: "contact", payload: { vcf_info: "BEGIN:VCARD\r\nFN:Лиза Ногти\r\nTEL:79990000000\r\nEND:VCARD\r\n" } }]
        }
      }
    }]);

    const data = await repository.read();
    const channel = data.channels.find((item) => item.maxChannelId === String(chatId));
    const message = (await repository.listUnprocessedChatMessages(channel!.id))[0];
    await repository.saveContactDirectoryCandidate({
      channel: channel!,
      message,
      candidate: {
        category: "мастер маникюра",
        contactName: "Лиза Ногти",
        phone: "79990000000",
        maxContactId: null,
        attachmentFingerprint: "contact-fingerprint",
        rawAttachment: { type: "contact", payload: { vcf_info: "BEGIN:VCARD\r\nFN:Лиза Ногти\r\nTEL:79990000000\r\nEND:VCARD\r\n" } },
        sourceContext: "посоветуйте мастера маникюра"
      }
    });

    const found = await repository.searchContactDirectory({
      channel: channel!,
      query: {
        text: "посоветуйте мастера по ногтям",
        category: "мастер",
        subcategory: "ногти",
        searchTerms: ["маникюр"]
      }
    });

    expect(found).toHaveLength(1);
    expect(found[0].contactName).toBe("Лиза Ногти");
  });

  it("builds outbound MAX contact-card attachments from saved raw payload", () => {
    const attachments = buildMaxContactAttachments([{
      id: "contact-id",
      cityId: "city-id",
      channelId: "channel-id",
      category: "мастер маникюра",
      normalizedCategory: "мастер маникюра",
      contactName: "Лиза Ногти",
      phone: "79990000000",
      normalizedPhone: "79990000000",
      maxContactId: null,
      rawAttachment: {
        type: "contact",
        payload: {
          vcf_info: "BEGIN:VCARD\r\nFN:Лиза Ногти\r\nTEL:79990000000\r\nEND:VCARD\r\n",
          hash: "hash-value"
        }
      },
      sourceMessageId: "mid-1",
      sourceAuthorName: "Анна",
      sourceContext: "",
      firstSeenAt: "2026-08-11T00:00:00.000Z",
      lastSeenAt: "2026-08-11T00:00:00.000Z",
      timesShared: 1
    }]);

    expect(attachments).toEqual([{
      type: "contact",
      payload: {
        vcf_info: "BEGIN:VCARD\r\nFN:Лиза Ногти\r\nTEL:79990000000\r\nEND:VCARD\r\n",
        hash: "hash-value"
      }
    }]);
  });
});
