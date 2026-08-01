import "dotenv/config";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local", override: false });

type HttpMethod = "GET" | "POST" | "DELETE";

const command = process.argv[2] || "list";

try {
  if (command === "list") {
    console.log(JSON.stringify(await requestJson("GET", "/subscriptions"), null, 2));
  } else if (command === "subscribe") {
    const webhookUrl = requiredEnv("MAX_WEBHOOK_URL");
    const secret = requiredEnv("MAX_WEBHOOK_SECRET");
    assertValidWebhookSecret(secret);

    const updateTypes = (process.env.MAX_WEBHOOK_UPDATE_TYPES || "message_created,bot_started,bot_added,message_edited,message_removed")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const result = await requestJson("POST", "/subscriptions", {
      url: webhookUrl,
      update_types: updateTypes,
      secret
    });
    console.log(JSON.stringify(redactSecrets(result), null, 2));
  } else if (command === "delete") {
    console.log(JSON.stringify(await requestJson("DELETE", "/subscriptions"), null, 2));
  } else {
    throw new Error("Usage: npm run max:webhook:list | max:webhook:subscribe | max:webhook:delete");
  }
} catch (error) {
  console.error(redactText(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

async function requestJson(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
  const baseUrl = process.env.MAX_API_BASE_URL || "https://platform-api2.max.ru";
  const token = requiredEnv("MAX_API_TOKEN");
  const url = new URL(path, baseUrl);
  const text = await requestText(url, method, token, process.env.MAX_API_CA_FILE, body);
  return text ? JSON.parse(text) : { ok: true };
}

async function requestText(url: URL, method: HttpMethod, token: string, caFile?: string, body?: unknown): Promise<string> {
  const ca = caFile ? await readFile(caFile, "utf8") : undefined;
  const requestBody = body === undefined ? undefined : JSON.stringify(body);

  return await new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method,
      headers: {
        Authorization: token,
        ...(requestBody === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody).toString()
        })
      },
      ca
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`MAX API ${method} ${url.pathname} failed with ${res.statusCode ?? 0}: ${responseBody}`));
          return;
        }
        resolve(responseBody);
      });
    });

    req.on("error", reject);
    if (requestBody) {
      req.write(requestBody);
    }
    req.end();
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertValidWebhookSecret(secret: string): void {
  if (!/^[a-zA-Z0-9_-]{5,256}$/.test(secret)) {
    throw new Error("MAX_WEBHOOK_SECRET must be 5-256 chars and contain only A-Z, a-z, 0-9, _ or -");
  }
}

function redactSecrets(value: unknown): unknown {
  return JSON.parse(redactText(JSON.stringify(value)));
}

function redactText(text: string): string {
  for (const secret of [process.env.MAX_API_TOKEN, process.env.MAX_WEBHOOK_SECRET].filter(Boolean)) {
    text = text.replaceAll(secret as string, "[REDACTED]");
  }
  return text;
}
