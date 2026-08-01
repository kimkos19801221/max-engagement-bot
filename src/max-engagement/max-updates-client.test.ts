import { describe, expect, it } from "vitest";

import { MaxUpdatesClient } from "./max-updates-client.js";

describe("MAX updates client", () => {
  it("requires token before polling updates", async () => {
    const client = new MaxUpdatesClient({});

    await expect(client.getUpdates()).rejects.toThrow("MAX_API_TOKEN is required");
  });

  it("calls GET /updates with marker and update types", async () => {
    const calls: string[] = [];
    const client = new MaxUpdatesClient({
      token: "secret-token",
      fetchFn: async (url, init) => {
        calls.push(String(url));
        expect(init?.headers?.Authorization).toBe("secret-token");
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              marker: 42,
              updates: [{ update_type: "message_created", chat_id: 123 }]
            });
          }
        };
      }
    });

    const result = await client.getUpdates({
      marker: 41,
      limit: 10,
      timeout: 0,
      types: ["message_created", "bot_added"]
    });

    expect(result.marker).toBe(42);
    expect(result.updates).toHaveLength(1);
    expect(calls[0]).toContain("https://platform-api2.max.ru/updates");
    expect(calls[0]).toContain("marker=41");
    expect(calls[0]).toContain("types=message_created");
    expect(calls[0]).toContain("types=bot_added");
  });
});
