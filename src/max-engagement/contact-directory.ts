import { createHash } from "node:crypto";

import type { MaxEngagementChannelRecord, MaxEngagementChatMessageRecord } from "./types.js";

export type ContactDirectoryCandidate = {
  category: string;
  contactName: string | null;
  phone: string | null;
  maxContactId: string | null;
  attachmentFingerprint: string;
  rawAttachment: unknown;
  sourceContext: string;
};

type ContactClassification = {
  is_professional_contact: boolean;
  category: string;
  contact_name: string;
  reason: string;
};

const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";

export function hasRawAttachments(message: MaxEngagementChatMessageRecord): boolean {
  return Array.isArray(message.rawAttachments) && message.rawAttachments.length > 0;
}

export async function classifyProfessionalContactAttachment(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
}): Promise<ContactDirectoryCandidate | null> {
  const attachments = input.message.rawAttachments ?? [];
  if (attachments.length === 0) return null;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  const previousContext = input.recentMessages
    .filter((item) => item.id !== input.message.id)
    .slice(-8)
    .map((item) => `${item.authorName || "Участница"}: ${item.text || "[сообщение без текста]"}`)
    .join("\n");

  const rawJson = safeJson(attachments).slice(0, 12_000);
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
      instructions: [
        "Ты классификатор карточек контактов из городского группового чата MAX.",
        "Нужно определить только одно: является ли вложение контактом специалиста/организации, которым участник делится как рекомендацией или способом получить услугу.",
        "Используй текущий текст и предыдущий контекст. Например: 'вот хороший сантехник' + следующая карточка контакта => категория 'сантехник'.",
        "Если это просто личный контакт, назначение непонятно, либо профессиональный контекст недостаточно ясен — is_professional_contact=false.",
        "Не выдумывай профессию. Категория должна следовать из контекста.",
        "Не считай медицинскую историю, частные данные без сервисного контекста или случайную пересылку контакта профессиональной рекомендацией.",
        "Верни только JSON по схеме."
      ].join("\n"),
      input: [
        `ЧАТ: ${input.channel.title}`,
        "ПРЕДЫДУЩИЙ КОНТЕКСТ:",
        previousContext || "нет",
        "ТЕКУЩИЙ ТЕКСТ:",
        input.message.text || "[текста нет]",
        "RAW ATTACHMENTS:",
        rawJson
      ].join("\n\n"),
      max_output_tokens: 300,
      temperature: 0.1,
      text: {
        format: {
          type: "json_schema",
          name: "professional_contact_classification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              is_professional_contact: { type: "boolean" },
              category: { type: "string" },
              contact_name: { type: "string" },
              reason: { type: "string" }
            },
            required: ["is_professional_contact", "category", "contact_name", "reason"]
          }
        }
      }
    })
  });

  if (!response.ok) return null;
  const data = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  const text = extractOutputText(data).trim();
  if (!text) return null;

  let parsed: ContactClassification;
  try {
    parsed = JSON.parse(text) as ContactClassification;
  } catch {
    return null;
  }

  const category = normalizeCategory(parsed.category);
  if (!parsed.is_professional_contact || !category) return null;

  const rawAttachment = attachments.length === 1 ? attachments[0] : attachments;
  const phone = extractLikelyPhone(rawAttachment);
  const maxContactId = extractLikelyContactId(rawAttachment);
  const contactName = parsed.contact_name.trim().slice(0, 200) || extractLikelyName(rawAttachment);

  return {
    category,
    contactName: contactName || null,
    phone,
    maxContactId,
    attachmentFingerprint: fingerprintAttachment(rawAttachment),
    rawAttachment,
    sourceContext: [previousContext, input.message.text].filter(Boolean).join("\n").slice(-4000)
  };
}

export function fingerprintAttachment(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D+/g, "");
  return digits.length >= 7 ? digits : null;
}

export function normalizeCategory(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9 -]+/giu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function extractOutputText(data: {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}): string {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output ?? []).flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function extractLikelyPhone(value: unknown): string | null {
  const found = findStringByKey(value, /(phone|telephone|mobile|vcf_phone|tel)/i);
  return normalizePhone(found);
}

function extractLikelyContactId(value: unknown): string | null {
  const found = findStringByKey(value, /(contact_?id|max_?contact_?id|user_?id)/i);
  return found?.trim().slice(0, 200) || null;
}

function extractLikelyName(value: unknown): string | null {
  const found = findStringByKey(value, /^(name|display_name|contact_name|first_name)$/i);
  return found?.trim().slice(0, 200) || null;
}

function findStringByKey(value: unknown, keyPattern: RegExp): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keyPattern);
      if (found) return found;
    }
    return null;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keyPattern.test(key) && (typeof item === "string" || typeof item === "number")) {
      return String(item);
    }
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findStringByKey(item, keyPattern);
    if (found) return found;
  }
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[]";
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
}
