import { createHash } from "node:crypto";

import type { MaxEngagementChannelRecord, MaxEngagementChatMessageRecord } from "./types.js";
import { requestOpenAIResponses, type OpenAIResponsesData } from "./openai-responses.js";

export type ContactDirectoryCandidate = {
  category: string;
  contactName: string | null;
  phone: string | null;
  maxContactId: string | null;
  attachmentFingerprint: string;
  rawAttachment: unknown;
  sourceContext: string;
};

export type ContactDirectoryRecord = {
  id: string;
  cityId: string | null;
  channelId: string;
  category: string;
  normalizedCategory: string;
  contactName: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  maxContactId: string | null;
  rawAttachment: unknown;
  sourceMessageId: string;
  sourceAuthorName: string | null;
  sourceContext: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  timesShared: number;
};

export type ContactDirectorySearchInput = {
  text: string;
  category?: string | null;
  subcategory?: string | null;
  searchTerms?: string[];
};

type ContactClassification = {
  is_professional_contact: boolean;
  category: string;
  contact_name: string;
  reason: string;
};

const DEFAULT_MODEL = "gpt-4.1-mini";
const CONTACT_REPLY_PREFIX = "\u041d\u0430\u0448\u043b\u0430 \u043a\u043e\u043d\u0442\u0430\u043a\u0442";
const CONTACT_STOP_WORDS = new Set([
  "\u043f\u043e", "\u0434\u043b\u044f", "\u0435\u0441\u0442\u044c", "\u043d\u0443\u0436\u0435\u043d", "\u043d\u0443\u0436\u043d\u0430", "\u043d\u0443\u0436\u043d\u043e",
  "\u043f\u043e\u0441\u043e\u0432\u0435\u0442\u0443\u0439\u0442\u0435", "\u043f\u043e\u0434\u0441\u043a\u0430\u0436\u0438\u0442\u0435", "\u0445\u043e\u0440\u043e\u0448\u0438\u0439",
  "\u0445\u043e\u0440\u043e\u0448\u0435\u0433\u043e", "\u043c\u0430\u0441\u0442\u0435\u0440", "\u043c\u0430\u0441\u0442\u0435\u0440\u0430", "\u0441\u043f\u0435\u0446\u0438\u0430\u043b\u0438\u0441\u0442"
]);

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let data: OpenAIResponsesData;
  try {
    data = await requestOpenAIResponses({
      apiKey,
      payload: {
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
      },
      signal: controller.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

export function buildContactDirectorySearchTerms(input: ContactDirectorySearchInput): string[] {
  const values = [
    input.category ?? "",
    input.subcategory ?? "",
    ...(input.searchTerms ?? []),
    input.text
  ];
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = normalizeContactSearchText(value);
    if (normalized) terms.add(normalized);
    for (const token of tokenizeContactQuery(normalized)) {
      terms.add(token);
      for (const expanded of expandContactToken(token)) {
        terms.add(expanded);
      }
    }
  }
  return [...terms].filter((term) => term.length >= 3).slice(0, 40);
}

export function scoreContactDirectoryRecord(record: ContactDirectoryRecord, terms: string[]): number {
  const normalizedTerms = [...new Set(terms.map(normalizeContactSearchText).filter(Boolean))];
  if (normalizedTerms.length === 0) return 0;

  const category = normalizeContactSearchText(record.normalizedCategory || record.category);
  const name = normalizeContactSearchText(record.contactName ?? "");
  const context = normalizeContactSearchText(record.sourceContext ?? "");
  let score = 0;
  for (const term of normalizedTerms) {
    if (category === term) score += 12;
    else if (category.includes(term) || term.includes(category)) score += 8;
    if (name.includes(term)) score += 3;
    if (context.includes(term)) score += 2;
  }
  return score + Math.min(record.timesShared, 5);
}

export function formatContactDirectoryText(records: ContactDirectoryRecord[]): string {
  return records.slice(0, 3).map((record, index) => {
    const label = records.length === 1 ? CONTACT_REPLY_PREFIX : `${index + 1}. ${record.category}`;
    const name = record.contactName?.trim() || record.category;
    const phone = record.phone?.trim();
    return phone ? `${label}: ${name}, ${phone}` : `${label}: ${name}`;
  }).join("\n");
}

export function buildMaxContactAttachments(records: ContactDirectoryRecord[]): unknown[] {
  return records.slice(0, 3)
    .map((record) => normalizeMaxContactAttachment(record.rawAttachment))
    .filter((attachment): attachment is Record<string, unknown> => attachment !== null);
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

function normalizeContactSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0451/g, "\u0435")
    .replace(/[^\p{L}\p{N} -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function tokenizeContactQuery(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !CONTACT_STOP_WORDS.has(token));
}

function expandContactToken(token: string): string[] {
  const result: string[] = [];
  if (/(?:\u043c\u0430\u043d\u0438\u043a\u044e\u0440|\u043d\u043e\u0433\u0442)/u.test(token)) {
    result.push("\u043c\u0430\u0441\u0442\u0435\u0440 \u043c\u0430\u043d\u0438\u043a\u044e\u0440\u0430", "\u043c\u0430\u043d\u0438\u043a\u044e\u0440", "\u043d\u043e\u0433\u0442\u0438");
  }
  if (/\u0441\u0430\u043d\u0442\u0435\u0445/u.test(token)) {
    result.push("\u0441\u0430\u043d\u0442\u0435\u0445\u043d\u0438\u043a");
  }
  if (/\u044d\u043b\u0435\u043a\u0442\u0440/u.test(token)) {
    result.push("\u044d\u043b\u0435\u043a\u0442\u0440\u0438\u043a");
  }
  if (/\u0440\u0435\u043c\u043e\u043d\u0442/u.test(token)) {
    result.push("\u043c\u0430\u0441\u0442\u0435\u0440 \u043f\u043e \u0440\u0435\u043c\u043e\u043d\u0442\u0443");
  }
  if (/\u043d\u044f\u043d/u.test(token)) {
    result.push("\u043d\u044f\u043d\u044f");
  }
  if (/\u0440\u0435\u043f\u0435\u0442/u.test(token)) {
    result.push("\u0440\u0435\u043f\u0435\u0442\u0438\u0442\u043e\u0440");
  }
  if (/\u043f\u0430\u0440\u0438\u043a|\u0441\u0442\u0440\u0438\u0436|\u0432\u043e\u043b\u043e\u0441/u.test(token)) {
    result.push("\u043f\u0430\u0440\u0438\u043a\u043c\u0430\u0445\u0435\u0440");
  }
  if (/\u0432\u0438\u0437\u0430\u0436|\u043c\u0430\u043a\u0438\u044f\u0436/u.test(token)) {
    result.push("\u0432\u0438\u0437\u0430\u0436\u0438\u0441\u0442");
  }
  if (/\u043c\u0430\u0441\u0441\u0430\u0436/u.test(token)) {
    result.push("\u043c\u0430\u0441\u0441\u0430\u0436\u0438\u0441\u0442");
  }
  if (/\u043b\u043e\u0433\u043e\u043f\u0435\u0434/u.test(token)) {
    result.push("\u043b\u043e\u0433\u043e\u043f\u0435\u0434");
  }
  if (/\u043f\u0441\u0438\u0445\u043e\u043b/u.test(token)) {
    result.push("\u043f\u0441\u0438\u0445\u043e\u043b\u043e\u0433");
  }
  if (/\u0443\u0431\u043e\u0440|\u043a\u043b\u0438\u043d\u0438\u043d/u.test(token)) {
    result.push("\u043a\u043b\u0438\u043d\u0438\u043d\u0433");
  }
  return result;
}

function normalizeMaxContactAttachment(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.type !== "contact") return null;
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const payloadRow = payload as Record<string, unknown>;
  if (typeof payloadRow.vcf_info !== "string" || !payloadRow.vcf_info.trim()) return null;
  const cleanPayload: Record<string, unknown> = { vcf_info: payloadRow.vcf_info };
  if (payloadRow.max_info && typeof payloadRow.max_info === "object" && !Array.isArray(payloadRow.max_info)) {
    cleanPayload.max_info = payloadRow.max_info;
  }
  if (typeof payloadRow.hash === "string" && payloadRow.hash.trim()) {
    cleanPayload.hash = payloadRow.hash;
  }
  return { type: "contact", payload: cleanPayload };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
}
