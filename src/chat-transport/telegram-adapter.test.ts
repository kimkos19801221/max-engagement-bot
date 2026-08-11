import { describe, expect, it } from "vitest";
import { telegramUpdatesToUnified } from "./telegram-adapter.js";

describe("telegramUpdatesToUnified", () => {
  it("maps a group message and preserves contact raw payload", () => {
    const contact = { phone_number: "+79990000000", first_name: "Сергей", user_id: 42 };
    const [message] = telegramUpdatesToUnified([{
      update_id: 10,
      message: {
        message_id: 77,
        date: 1_700_000_000,
        chat: { id: -100123, type: "supergroup", title: "Мамочки" },
        from: { id: 5, first_name: "Анна", is_bot: false },
        contact
      }
    }]);

    expect(message).toMatchObject({
      platform: "telegram",
      externalChatId: "-100123",
      externalMessageId: "77",
      chatTitle: "Мамочки",
      authorId: "5",
      authorName: "Анна",
      text: ""
    });
    expect(message.attachments).toEqual([{ kind: "contact", raw: contact }]);
  });

  it("ignores private chats", () => {
    expect(telegramUpdatesToUnified([{
      update_id: 11,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: 5, type: "private" },
        from: { id: 5, first_name: "Анна" },
        text: "привет"
      }
    }])).toEqual([]);
  });

  it("preserves hidden text_link metadata for antispam", () => {
    const [message] = telegramUpdatesToUnified([{
      update_id: 12,
      message: {
        message_id: 2,
        date: 1_700_000_000,
        chat: { id: -10, type: "group" },
        text: "сюда",
        entities: [{ type: "text_link", offset: 0, length: 4, url: "https://example.com" }]
      }
    }]);
    expect(message.metadataText).toContain("https://example.com");
  });
});
