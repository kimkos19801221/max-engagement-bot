import type { CityMemoryCandidate, CityMemoryKnowledgeKind, CityMemoryObjectType } from "../city-memory/types.js";
import type { MaxEngagementChannelRecord, MaxEngagementChatMessageRecord } from "./types.js";
import { requestOpenAIResponses, type OpenAIResponsesData } from "./openai-responses.js";

type StructuredOutputFormat = {
  name: string;
  schema: Record<string, unknown>;
};

const DEFAULT_MODEL = "gpt-4.1-mini";

const OBJECT_TYPES = ["organization", "institution", "place", "service", "event", "temporary_change", "recommendation", "topic"] as const;
const KNOWLEDGE_KINDS = ["address", "contact", "service", "hours", "event", "temporary_change", "resident_recommendation", "correction", "summary"] as const;

const CITY_MEMORY_EXTRACTION_FORMAT: StructuredOutputFormat = {
  name: "city_memory_extraction",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            object_type: { type: "string", enum: [...OBJECT_TYPES] },
            object_name: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            categories: { type: "array", items: { type: "string" } },
            related_terms: { type: "array", items: { type: "string" } },
            knowledge_kind: { type: "string", enum: [...KNOWLEDGE_KINDS] },
            content: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            valid_until: {
              anyOf: [{ type: "string" }, { type: "null" }]
            }
          },
          required: [
            "object_type",
            "object_name",
            "aliases",
            "categories",
            "related_terms",
            "knowledge_kind",
            "content",
            "confidence",
            "valid_until"
          ]
        }
      }
    },
    required: ["candidates"]
  }
};

const CITY_MEMORY_EXTRACTION_PROMPT = [
  "You extract useful local city memory from Russian group-chat messages.",
  "Use only the current message as the source. Use recent context only to resolve what the current message answers.",
  "Return empty candidates when the current message is just chat, thanks, greetings, emotions, jokes, or has no concrete local information.",
  "Extract local shops, places, services, masters, schools, kindergartens, clinics, prices, addresses, schedules, events, reviews, recommendations, corrections, and confirmations.",
  "Do not turn a resident opinion into a verified fact. A single user's message is always an unverified resident recommendation.",
  "Do not save personal medical stories, accusations, private personal data, or unsupported treatment claims.",
  "Do not invent names, prices, contacts, addresses, or categories that are not supported by the current message and context.",
  "For prices, keep the original scope and uncertainty in content, for example: 'A resident reported paying 10000 for ...'.",
  "For recommendations/reviews, keep attribution as resident-reported, not official.",
  "If the message corrects previous local information, use knowledge_kind='correction'.",
  "For each candidate choose a concrete object_name. If the answer is 'in Peppi', object_name should be 'Peppi'.",
  "Return strict JSON only."
].join("\n");

export async function extractCityMemoryCandidatesFromMessage(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
  replyToMessage?: MaxEngagementChatMessageRecord | null;
}): Promise<CityMemoryCandidate[]> {
  if (!shouldTryCityMemoryExtraction(input.message, input.recentMessages)) {
    return [];
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OpenAI API key is missing");
  }

  const raw = await requestOpenAI({
    apiKey,
    maxOutputTokens: 1600,
    temperature: 0.1,
    format: CITY_MEMORY_EXTRACTION_FORMAT,
    instructions: CITY_MEMORY_EXTRACTION_PROMPT,
    input: [
      `City chat title: ${input.channel.title}`,
      "Recent context before current message:",
      formatRecentContext(input.recentMessages, input.message.id, 16),
      "Message replied to:",
      input.replyToMessage ? `${displayAuthor(input.replyToMessage)}: ${input.replyToMessage.text}` : "none",
      "Current source message:",
      `${displayAuthor(input.message)}: ${input.message.text}`
    ].join("\n\n")
  });

  return parseCityMemoryExtraction(raw);
}

export function parseCityMemoryExtraction(text: string): CityMemoryCandidate[] {
  const value = parseStrictJson(text);
  assertOnlyKeys(value, ["candidates"], "city memory extraction");
  if (!Array.isArray(value.candidates)) throw new Error("candidates must be array");
  return value.candidates.slice(0, 5).map((item, index) => parseCandidate(objectValue(item, `candidates[${index}]`)));
}

function shouldTryCityMemoryExtraction(
  message: MaxEngagementChatMessageRecord,
  recentMessages: MaxEngagementChatMessageRecord[]
): boolean {
  const text = message.text.trim();
  if (message.authorIsBot || text.length < 4) return false;
  const lowValuePattern = new RegExp(
    String.raw`^(?:\u0441\u043f\u0430\u0441\u0438\u0431\u043e|\u0441\u043f\u0441|\u0431\u043b\u0430\u0433\u043e\u0434\u0430\u0440\u044e|\u0434\u043e\u0431\u0440\u043e\u0435 \u0443\u0442\u0440\u043e|\u0434\u043e\u0431\u0440\u044b\u0439 \u0434\u0435\u043d\u044c|\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435|\u043f\u0440\u0438\u0432\u0435\u0442)[\s!.]*$`,
    "iu"
  );
  if (lowValuePattern.test(text)) {
    return false;
  }
  if (text.length >= 16) return true;
  const localQuestionPattern = new RegExp(
    String.raw`[?]|(?:\u0433\u0434\u0435|\u043a\u0442\u043e|\u043f\u043e\u0441\u043e\u0432\u0435\u0442|\u043f\u043e\u0434\u0441\u043a\u0430\u0436|\u043d\u0443\u0436\u043d|\u0438\u0449\u0443|\u043f\u043e\u043a\u0443\u043f\u0430)`,
    "iu"
  );
  return recentMessages.slice(-8).some((item) => localQuestionPattern.test(item.text));
}

function parseCandidate(value: Record<string, unknown>): CityMemoryCandidate {
  assertOnlyKeys(value, ["object_type", "object_name", "aliases", "categories", "related_terms", "knowledge_kind", "content", "confidence", "valid_until"], "city memory candidate");
  const confidence = numberValue(value.confidence, "confidence", 0, 1);
  return {
    objectType: enumValue(value.object_type, OBJECT_TYPES, "object_type") as CityMemoryObjectType,
    objectName: nonEmptyString(value.object_name, "object_name", 200),
    aliases: stringArray(value.aliases, "aliases", 12, 120),
    categories: stringArray(value.categories, "categories", 12, 120),
    relatedTerms: stringArray(value.related_terms, "related_terms", 16, 120),
    knowledgeKind: enumValue(value.knowledge_kind, KNOWLEDGE_KINDS, "knowledge_kind") as CityMemoryKnowledgeKind,
    content: nonEmptyString(value.content, "content", 2000),
    confidence: Math.min(confidence, 0.75),
    trust: "single_resident",
    validUntil: nullableString(value.valid_until, "valid_until", 50)
  };
}

function formatRecentContext(messages: MaxEngagementChatMessageRecord[], currentId: string, limit: number): string {
  const lines = messages
    .filter((item) => item.id !== currentId)
    .slice(-limit)
    .map((item) => `${displayAuthor(item)}: ${item.text}`);
  return lines.length ? lines.join("\n") : "none";
}

function displayAuthor(message: MaxEngagementChatMessageRecord): string {
  return message.authorName || (message.authorIsBot ? "Alina" : "participant");
}

function parseStrictJson(text: string): Record<string, unknown> {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(clean);
  return objectValue(parsed, "JSON response");
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], field: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length) throw new Error(`${field} contains unsupported fields: ${extra.join(", ")}`);
  for (const key of allowed) if (!(key in value)) throw new Error(`${field} is missing field: ${key}`);
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${field} has invalid value`);
  return value as T[number];
}

function numberValue(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number from ${min} to ${max}`);
  }
  return value;
}

function stringValue(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be string`);
  return value.trim().slice(0, max);
}

function nonEmptyString(value: unknown, field: string, max: number): string {
  const result = stringValue(value, field, max);
  if (!result) throw new Error(`${field} must not be empty`);
  return result;
}

function nullableString(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  return stringValue(value, field, max) || null;
}

function stringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be array`);
  const items = value.map((item) => stringValue(item, field, maxLength)).filter(Boolean);
  return [...new Set(items)].slice(0, maxItems);
}

async function requestOpenAI(input: {
  apiKey: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  temperature: number;
  format: StructuredOutputFormat;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const data = await requestOpenAIResponses({
      apiKey: input.apiKey,
      payload: {
        model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
        instructions: input.instructions,
        input: input.input,
        max_output_tokens: input.maxOutputTokens,
        temperature: input.temperature,
        text: {
          format: {
            type: "json_schema",
            name: input.format.name,
            schema: input.format.schema,
            strict: true
          }
        }
      },
      signal: controller.signal
    });
    const text = extractText(data).trim();
    if (!text) throw new Error("OpenAI returned an empty response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(data: OpenAIResponsesData): string {
  if (data.output_text) return data.output_text;
  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? "")
    .join("")
    .trim();
}
