import type { CityMemorySearchResult, CityMemoryCandidate } from "../city-memory/types.js";
import type { MaxEngagementChannelRecord, MaxEngagementChatMessageRecord } from "./types.js";

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
};

type StructuredOutputFormat = {
  name: string;
  schema: Record<string, unknown>;
};

const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";

const ACTIONS = ["ignore", "clarify", "search", "save", "search_and_save", "reply_without_search"] as const;
const MESSAGE_TYPES = ["request", "shared_experience", "response_to_bot", "casual", "sensitive", "technical"] as const;
const TARGETS = ["bot", "whole_chat", "specific_participant", "unclear", "none"] as const;
const REQUEST_SCOPES = ["local", "global", "mixed"] as const;
const RISKS = ["none", "medical", "personal_data", "accusation", "advertising", "unverified_treatment", "other"] as const;
const RISK_BEHAVIORS = ["normal", "silent", "careful_reply", "moderation_review"] as const;

// Risks that must never be surfaced publicly regardless of what the model set should_reply to.
const UNSAFE_RISKS = new Set<typeof RISKS[number]>(["personal_data", "accusation", "unverified_treatment"]);

const ORCHESTRATOR_FORMAT: StructuredOutputFormat = {
  name: "orchestrator_decision",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message_type: { type: "string", enum: [...MESSAGE_TYPES] },
      request_target: { type: "string", enum: [...TARGETS] },
      request_scope: { type: "string", enum: [...REQUEST_SCOPES] },
      action: { type: "string", enum: [...ACTIONS] },
      should_reply: { type: "boolean" },
      should_search_memory: { type: "boolean" },
      should_save_memory: { type: "boolean" },
      category: { type: "string" },
      subcategory: { type: "string" },
      search_terms: { type: "array", items: { type: "string" } },
      clarification_question: {
        anyOf: [{ type: "string" }, { type: "null" }]
      },
      risk: { type: "string", enum: [...RISKS] },
      risk_behavior: { type: "string", enum: [...RISK_BEHAVIORS] },
      already_answered_by_participants: { type: "boolean" },
      intervention_useful: { type: "boolean" },
      reason: { type: "string" },
      memory_candidate: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              object_type: {
                type: "string",
                enum: ["organization", "institution", "place", "service", "event", "temporary_change", "recommendation", "topic"]
              },
              object_name: { type: "string" },
              aliases: { type: "array", items: { type: "string" } },
              categories: { type: "array", items: { type: "string" } },
              related_terms: { type: "array", items: { type: "string" } },
              knowledge_kind: {
                type: "string",
                enum: ["address", "contact", "service", "hours", "event", "temporary_change", "resident_recommendation", "correction", "summary"]
              },
              content: { type: "string" },
              // Bounded in the schema and validated again at runtime.
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
        ]
      }
    },
    required: [
      "message_type",
      "request_target",
      "request_scope",
      "action",
      "should_reply",
      "should_search_memory",
      "should_save_memory",
      "category",
      "subcategory",
      "search_terms",
      "clarification_question",
      "risk",
      "risk_behavior",
      "already_answered_by_participants",
      "intervention_useful",
      "reason",
      "memory_candidate"
    ]
  }
};

const FINAL_REPLY_FORMAT: StructuredOutputFormat = {
  name: "city_assistant_final_reply",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      should_publish: { type: "boolean" },
      reply: { type: "string" },
      used_fact_ids: { type: "array", items: { type: "string" } },
      unsupported_local_claims: { type: "boolean" },
      reason: { type: "string" }
    },
    required: [
      "should_publish",
      "reply",
      "used_fact_ids",
      "unsupported_local_claims",
      "reason"
    ]
  }
};

export type CityAssistantPlan = {
  messageType: typeof MESSAGE_TYPES[number];
  requestTarget: typeof TARGETS[number];
  requestScope: typeof REQUEST_SCOPES[number];
  action: typeof ACTIONS[number];
  shouldReply: boolean;
  shouldSearchMemory: boolean;
  shouldSaveMemory: boolean;
  category: string;
  subcategory: string;
  searchTerms: string[];
  clarificationQuestion: string | null;
  risk: typeof RISKS[number];
  riskBehavior: typeof RISK_BEHAVIORS[number];
  alreadyAnsweredByParticipants: boolean;
  interventionUseful: boolean;
  reason: string;
  memoryCandidate: CityMemoryCandidate | null;
};

export type CityAssistantReply = {
  shouldReply: boolean;
  text: string;
  safetyReason: string;
  usedFactIds: string[];
};

export function buildFallbackCityReply(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  reason: string;
}): CityAssistantReply {
  const text = input.message.text.trim();
  const normalized = text.toLowerCase();
  const botName = channelBotName(input.channel).toLowerCase();
  const directMention = normalized.includes(botName);
  const asksChat =
    /(?:подскажите|посоветуйте|кто знает|что вы|как вы|где|куда|какой|какая|какие|\?)/i.test(text);

  if (!directMention && !asksChat) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: `Fallback skipped: message is not a clear request; ${input.reason}`,
      usedFactIds: []
    };
  }

  if (/(?:голов|мигрен|таблет|лекарств|болит|боль|температур|давлен)/i.test(normalized)) {
    return {
      shouldReply: true,
      text: [
        "С лекарствами лучше аккуратно: я бы не советовала конкретные таблетки в чате, особенно если есть беременность, ГВ, давление или другие симптомы.",
        "Безопаснее уточнить у врача или фармацевта, а если боль сильная, необычная или не проходит - не тянуть с медпомощью."
      ].join(" "),
      safetyReason: `Fallback medical-safe reply: ${input.reason}`,
      usedFactIds: []
    };
  }

  if (/(?:садик|садик[аиоеу]?|детск(?:ий|ого|ом)|школ|круж|секци)/i.test(normalized)) {
    return {
      shouldReply: true,
      text: [
        "Пока в базе нет конкретных рекомендаций по этому вопросу.",
        "Лучше смотреть варианты по району, отзывам родителей и сходить лично посмотреть условия.",
        "Девочки, кто может посоветовать проверенные варианты, напишите район, название и что понравилось или не понравилось - это поможет другим."
      ].join(" "),
      safetyReason: `Fallback local recommendation reply: ${input.reason}`,
      usedFactIds: []
    };
  }

  if (directMention) {
    return {
      shouldReply: true,
      text: "Я здесь. Сейчас могу отвечать только в безопасном базовом режиме: если нужен совет по месту, услуге или варианту, напишите район и детали, а девочки смогут добавить свой опыт.",
      safetyReason: `Fallback direct mention reply: ${input.reason}`,
      usedFactIds: []
    };
  }

  return {
    shouldReply: true,
    text: "Пока нет сохраненных рекомендаций по этому вопросу.",
    safetyReason: `Fallback general request reply: ${input.reason}`,
    usedFactIds: []
  };
}

export async function analyzeCityMessage(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
  replyToMessage?: MaxEngagementChatMessageRecord | null;
  memoryPreview?: CityMemorySearchResult[];
}): Promise<CityAssistantPlan> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OpenAI API key is missing");

  const history = formatHistory(input.channel, input.recentMessages, input.message.id, 30);
  const directMention = Boolean(channelBotName(input.channel) && input.message.text.toLowerCase().includes(channelBotName(input.channel).toLowerCase()));
  const replyToBot = Boolean(input.replyToMessage?.authorIsBot);
  const memoryPreview = formatMemory(input.memoryPreview ?? [], 8, 3);

  const raw = await requestOpenAI({
    apiKey,
    maxOutputTokens: 1200,
    temperature: 0.15,
    format: ORCHESTRATOR_FORMAT,
    instructions: ORCHESTRATOR_PROMPT,
    input: [
      `ГОРОДСКОЙ ЧАТ: ${input.channel.title}`,
      `ПРЯМОЕ УПОМИНАНИЕ АЛИНЫ: ${directMention ? "да" : "нет"}`,
      `ОТВЕТ НА СООБЩЕНИЕ АЛИНЫ: ${replyToBot ? "да" : "нет"}`,
      "СООБЩЕНИЕ, НА КОТОРОЕ ОТВЕЧАЮТ:",
      input.replyToMessage ? `${displayAuthor(input.channel, input.replyToMessage)}: ${input.replyToMessage.text}` : "нет",
      "ПОСЛЕДНИЕ СООБЩЕНИЯ ЧАТА:",
      history || "История отсутствует.",
      "КРАТКАЯ РЕЛЕВАНТНАЯ ПАМЯТЬ ГОРОДА:",
      memoryPreview || "Подходящей памяти пока нет.",
      "ТЕКУЩЕЕ СООБЩЕНИЕ:",
      `${input.message.authorName || "Участница"}: ${input.message.text}`
    ].join("\n\n")
  });

  return parsePlan(raw);
}

export async function generateCityReply(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
  plan: CityAssistantPlan;
  memory: CityMemorySearchResult[];
}): Promise<CityAssistantReply> {
  if (!input.plan.shouldReply) {
    return { shouldReply: false, text: "", safetyReason: `AI plan: ${input.plan.reason}`, usedFactIds: [] };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { shouldReply: false, text: "", safetyReason: "OpenAI API key is missing; chat reply skipped", usedFactIds: [] };
  }

  const facts = flattenFacts(input.memory);
  const raw = await requestOpenAI({
    apiKey,
    maxOutputTokens: 650,
    temperature: 0.35,
    format: FINAL_REPLY_FORMAT,
    instructions: FINAL_REPLY_PROMPT,
    input: [
      `ЧАТ: ${input.channel.title}`,
      // Serialized in snake_case to match the field names FINAL_REPLY_PROMPT actually
      // refers to (e.g. "request_scope"). Passing the raw camelCase TS object here
      // previously meant the prompt's field references didn't line up with the JSON keys.
      `РЕШЕНИЕ ОРКЕСТРАТОРА: ${JSON.stringify(planToPromptRecord(input.plan))}`,
      "АКТУАЛЬНЫЕ ПОСЛЕДНИЕ СООБЩЕНИЯ:",
      formatHistory(input.channel, input.recentMessages, input.message.id, 30) || "История отсутствует.",
      "РАЗРЕШЁННЫЕ ФАКТЫ ИЗ ГОРОДСКОЙ ПАМЯТИ:",
      facts.length ? facts.map((fact) => JSON.stringify(fact)).join("\n") : "Фактов нет.",
      "ИСХОДНОЕ СООБЩЕНИЕ:",
      `${input.message.authorName || "Участница"}: ${input.message.text}`
    ].join("\n\n")
  });

  const parsed = parseFinalReply(raw);
  if (!parsed.shouldPublish || !parsed.reply.trim()) {
    return { shouldReply: false, text: "", safetyReason: `AI final decision: ${parsed.reason}`, usedFactIds: [] };
  }

  const allowedIds = new Set(facts.map((fact) => fact.id));
  if (parsed.usedFactIds.some((id) => !allowedIds.has(id))) {
    throw new Error("Final AI reply referenced a fact that was not supplied by the server");
  }

  return {
    shouldReply: true,
    text: parsed.reply.slice(0, 1800),
    safetyReason: `AI final decision: ${parsed.reason}`,
    usedFactIds: parsed.usedFactIds
  };
}

const ORCHESTRATOR_PROMPT = [
  "Ты — оркестратор городского ИИ-помощника Алины в групповом чате для мам.",
  "Ты принимаешь все смысловые решения. Сервер только безопасно исполняет твой план.",
  "Оцени сообщение как внимательная участница чата. Отвечай только когда сообщение явно адресовано Алине: участница называет Алину, отвечает на сообщение Алины или однозначно продолжает диалог с ней. Если вопрос адресован всему чату, например «девочки, подскажите», «кто знает», «посоветуйте», но к Алине не обращаются, не отвечай и выбери should_reply=false. При этом полезные локальные факты из таких сообщений можешь молча анализировать и сохранять в память, если они подходят по правилам. Никогда не придумывай то, чего не знаешь.",
  "Упоминание имени Алина само по себе не означает запрос: благодарность, обсуждение Алины и обычная реплика могут требовать молчания.",
  "Для каждого запроса определи request_scope: local, global или mixed.",
  "local — ответ зависит от конкретного города: местные врачи, садики, школы, магазины, мастера, услуги, организации, адреса, телефоны, графики, события, отключения, цены или вопрос «где в этом городе». Для local используй городскую память и не придумывай локальные факты.",
  "global — вопрос не зависит от города: бренды, товары, модели, общие бытовые советы, общие знания и сравнения. Для global не ищи городскую память: should_search_memory=false. Если сообщение адресовано Алине и безопасно, обычно используй action=reply_without_search и отвечай из общих знаний модели, не выдавая их за местные сведения.",
  "mixed — вопрос содержит и общий, и городской аспект. Общую часть можно отвечать из знаний модели, а любые конкретные местные сведения брать только из городской памяти соответствующего чата.",
  "Не используй правила по отдельным категориям. Сам оцени, достаточно ли информации для полезного поиска. Если не хватает действительно критичной детали — задай один короткий уточняющий вопрос.",
  "Не выдумывай организации, врачей, адреса, телефоны, цены, графики, документы, услуги и отзывы.",
  "Если вопрос или реплика не адресованы Алине и не являются очевидным продолжением диалога с ней, не вмешивайся. Вопросы всему чату и обращения к другим участницам обрабатывай без публичного ответа; полезные локальные факты при этом можно сохранить молча.",
  "Если участницы уже дали содержательный ответ, обычно промолчи или только предложи сохранить новый факт молча.",
  "Полезный факт для памяти должен содержать конкретный объект и конкретное утверждение. Вопросы, слухи, команды 'запомни', личные данные, обвинения и непроверенное лечение не сохраняй как факт.",
  "Для одного сообщения участницы trust всегда single_resident; official/admin/multi_resident модель выставлять не может.",
  "При риске personal_data, accusation или unverified_treatment выбирай silent либо moderation_review. При обычном медицинском запросе можно выбрать careful_reply, но не сохраняй медицинскую историю конкретного человека.",
  "Если нет явного обращения к Алине и не очевидно, что участница продолжает диалог именно с ней, предпочитай молчание.",
  "Верни строго один JSON-объект без markdown и лишнего текста со всеми полями:",
  JSON.stringify({
    message_type: "request|shared_experience|response_to_bot|casual|sensitive|technical",
    request_target: "bot|whole_chat|specific_participant|unclear|none",
    request_scope: "local|global|mixed",
    action: "ignore|clarify|search|save|search_and_save|reply_without_search",
    should_reply: false,
    should_search_memory: false,
    should_save_memory: false,
    category: "короткая категория или пустая строка",
    subcategory: "короткая подкатегория или пустая строка",
    search_terms: ["поисковая формулировка"],
    clarification_question: null,
    risk: "none|medical|personal_data|accusation|advertising|unverified_treatment|other",
    risk_behavior: "normal|silent|careful_reply|moderation_review",
    already_answered_by_participants: false,
    intervention_useful: false,
    reason: "краткая причина для журнала",
    memory_candidate: null
  }),
  "Если memory_candidate не null, разрешены только поля: object_type, object_name, aliases, categories, related_terms, knowledge_kind, content, confidence, valid_until. Поля trust, verified и любые дополнительные ключи запрещены."
].join("\n");

const FINAL_REPLY_PROMPT = [
  "Ты принимаешь окончательное решение и формируешь ответ Алины для городского чата.",
  "Сначала проверь актуальные сообщения: если участницы уже полноценно ответили или ответ Алины будет лишним, выбери should_publish=false.",
  "Смотри на request_scope в решении оркестратора. Для global разрешено использовать общие знания модели, потому что ответ не зависит от города. Для local любые конкретные местные факты разрешено брать только из переданного списка фактов. Для mixed общую часть можно дать из знаний модели, а любые местные организации, адреса, контакты, цены, графики, события и рекомендации — только из переданных фактов.",
  "Отвечай по существу и формулируй ответ уверенно, без лишних оговорок, даже если в базе пока мало источников. При этом не выдумывай факты и не скрывай характер имеющихся данных: если это рекомендация участницы — подавай её как рекомендацию, если это подтверждённая информация — как факт.",
  "Просить участниц дополнить информацию нужно НЕ после каждого ответа. Делай это только для local или локальной части mixed-запроса, когда для полезного ответа не хватает конкретных городских сведений или когда действительно нужно собрать дополнительные проверяемые локальные данные для городской памяти.",
  "Для global-запросов, общих бытовых вопросов, общих знаний, воспитания, товаров и обычных медицинских вопросов не добавляй автоматический призыв «делитесь опытом», если он не нужен непосредственно для ответа.",
  "Если подходящих local-сведений в базе нет, коротко скажи об этом и попроси участниц добавить именно недостающие конкретные сведения: название специалиста или организации, район, адрес, контакты, график, цену, услугу, местное изменение или проверенный опыт обращения.",
  "Не проси абстрактно «поделиться опытом» ради активности. Если полноценный ответ уже дан из общих знаний модели, просто закончи ответ без искусственного вопроса к чату.",
  "Не начинай ответ с приветствия, если разговор уже идёт. Не используй формальные вступления вроде «Добрый день», «Здравствуйте» или «К сожалению».",
  "Пиши как обычная участница чата, а не как служба поддержки или официальный администратор.",
  "Не повторяй вопрос пользователя. Не обращайся по имени без необходимости.",
  "Не используй выражение «в нашем городе», если город уже понятен из контекста.",
  "Формулируй ответ и призыв каждый раз заново, естественно. Не используй одинаковые окончания и повторяющиеся обороты в соседних сообщениях.",
  "Обычно ответ вместе с призывом должен занимать от одного до четырёх коротких предложений.",
  "Факт single_resident называй упоминанием, рекомендацией или опытом участницы, а не проверенной информацией.",
  "Верни строго JSON без markdown: {\"should_publish\":boolean,\"reply\":string,\"used_fact_ids\":string[],\"unsupported_local_claims\":boolean,\"reason\":string}.",
  "Если unsupported_local_claims=true, обязательно should_publish=false и reply пустая строка."
].join("\n");

// Converts the internal camelCase plan back to the snake_case shape that
// ORCHESTRATOR_FORMAT/ORCHESTRATOR_PROMPT actually describe, so the field
// names referenced inside FINAL_REPLY_PROMPT (e.g. "request_scope") match
// what's literally present in the JSON handed to the model.
function planToPromptRecord(plan: CityAssistantPlan): Record<string, unknown> {
  return {
    message_type: plan.messageType,
    request_target: plan.requestTarget,
    request_scope: plan.requestScope,
    action: plan.action,
    should_reply: plan.shouldReply,
    should_search_memory: plan.shouldSearchMemory,
    should_save_memory: plan.shouldSaveMemory,
    category: plan.category,
    subcategory: plan.subcategory,
    search_terms: plan.searchTerms,
    clarification_question: plan.clarificationQuestion,
    risk: plan.risk,
    risk_behavior: plan.riskBehavior,
    already_answered_by_participants: plan.alreadyAnsweredByParticipants,
    intervention_useful: plan.interventionUseful,
    reason: plan.reason,
    memory_candidate: plan.memoryCandidate
      ? {
          object_type: plan.memoryCandidate.objectType,
          object_name: plan.memoryCandidate.objectName,
          aliases: plan.memoryCandidate.aliases,
          categories: plan.memoryCandidate.categories,
          related_terms: plan.memoryCandidate.relatedTerms,
          knowledge_kind: plan.memoryCandidate.knowledgeKind,
          content: plan.memoryCandidate.content,
          confidence: plan.memoryCandidate.confidence,
          valid_until: plan.memoryCandidate.validUntil
        }
      : null
  };
}

function parsePlan(text: string): CityAssistantPlan {
  const value = parseStrictJson(text);

  if (!("search_terms" in value)) value.search_terms = [];
  if (!("clarification_question" in value)) value.clarification_question = null;
  if (!("memory_candidate" in value)) value.memory_candidate = null;

  assertOnlyKeys(value, [
    "message_type", "request_target", "request_scope", "action", "should_reply", "should_search_memory", "should_save_memory",
    "category", "subcategory", "search_terms", "clarification_question", "risk", "risk_behavior",
    "already_answered_by_participants", "intervention_useful", "reason", "memory_candidate"
  ], "orchestrator decision");

  const action = enumValue(value.action, ACTIONS, "action");
  const messageType = enumValue(value.message_type, MESSAGE_TYPES, "message_type");
  const requestTarget = enumValue(value.request_target, TARGETS, "request_target");
  const requestScope = enumValue(value.request_scope, REQUEST_SCOPES, "request_scope");
  const risk = enumValue(value.risk, RISKS, "risk");
  const riskBehavior = enumValue(value.risk_behavior, RISK_BEHAVIORS, "risk_behavior");
  const rawCandidate = value.memory_candidate;
  const candidate = rawCandidate === null ? null : parseCandidate(objectValue(rawCandidate, "memory_candidate"));

  // --- Code-level safety guardrails (do not rely on the model following the prompt) ---

  // Fail closed without throwing: one inconsistent model decision must not break the worker.
  // Personal data, accusations and unverified treatment are never published, searched in
  // city memory, or saved as city-memory facts.
  const unsafeRisk = UNSAFE_RISKS.has(risk);

  let shouldReply = booleanValue(value.should_reply, "should_reply");
  if (unsafeRisk || riskBehavior === "silent" || riskBehavior === "moderation_review") {
    shouldReply = false;
  }

  // Global requests must never trigger a city-memory search. Unsafe content is also kept
  // out of memory-search flow so it cannot be propagated through local context.
  let shouldSearchMemory = booleanValue(value.should_search_memory, "should_search_memory");
  if (requestScope === "global" || unsafeRisk) {
    shouldSearchMemory = false;
  }

  // Unsafe content must never enter city memory even if the model returned a candidate.
  const shouldSaveMemory =
    !unsafeRisk &&
    booleanValue(value.should_save_memory, "should_save_memory") &&
    candidate !== null;
  return {
    messageType,
    requestTarget,
    requestScope,
    action,
    shouldReply,
    shouldSearchMemory,
    shouldSaveMemory,
    category: stringValue(value.category, "category", 120),
    subcategory: stringValue(value.subcategory, "subcategory", 120),
    searchTerms: stringArray(value.search_terms, "search_terms", 12, 160),
    clarificationQuestion: nullableString(value.clarification_question, "clarification_question", 400),
    risk,
    riskBehavior,
    alreadyAnsweredByParticipants: booleanValue(value.already_answered_by_participants, "already_answered_by_participants"),
    interventionUseful: booleanValue(value.intervention_useful, "intervention_useful"),
    reason: stringValue(value.reason, "reason", 500),
    memoryCandidate: shouldSaveMemory ? candidate : null
  };
}

function parseCandidate(value: Record<string, unknown>): CityMemoryCandidate {
  assertOnlyKeys(value, ["object_type", "object_name", "aliases", "categories", "related_terms", "knowledge_kind", "content", "confidence", "valid_until"], "memory_candidate");
  const objectTypes = ["organization", "institution", "place", "service", "event", "temporary_change", "recommendation", "topic"] as const;
  const knowledgeKinds = ["address", "contact", "service", "hours", "event", "temporary_change", "resident_recommendation", "correction", "summary"] as const;
  const confidence = numberValue(value.confidence, "memory_candidate.confidence", 0, 1);
  return {
    objectType: enumValue(value.object_type, objectTypes, "memory_candidate.object_type"),
    objectName: nonEmptyString(value.object_name, "memory_candidate.object_name", 200),
    aliases: stringArray(value.aliases, "memory_candidate.aliases", 12, 120),
    categories: stringArray(value.categories, "memory_candidate.categories", 12, 120),
    relatedTerms: stringArray(value.related_terms, "memory_candidate.related_terms", 16, 120),
    knowledgeKind: enumValue(value.knowledge_kind, knowledgeKinds, "memory_candidate.knowledge_kind"),
    content: nonEmptyString(value.content, "memory_candidate.content", 2000),
    confidence: Math.min(confidence, 0.75),
    trust: "single_resident",
    validUntil: nullableString(value.valid_until, "memory_candidate.valid_until", 50)
  };
}

function parseFinalReply(text: string): { shouldPublish: boolean; reply: string; usedFactIds: string[]; reason: string } {
  const value = parseStrictJson(text);
  assertOnlyKeys(value, ["should_publish", "reply", "used_fact_ids", "unsupported_local_claims", "reason"], "final reply");
  const unsupported = booleanValue(value.unsupported_local_claims, "unsupported_local_claims");
  const shouldPublish = booleanValue(value.should_publish, "should_publish") && !unsupported;
  return {
    shouldPublish,
    reply: stringValue(value.reply, "reply", 1800),
    usedFactIds: stringArray(value.used_fact_ids, "used_fact_ids", 30, 100),
    reason: stringValue(value.reason, "reason", 500)
  };
}

function flattenFacts(memory: CityMemorySearchResult[]) {
  return memory.slice(0, 8).flatMap((item) => item.knowledge.slice(0, 6).map((fact) => ({
    id: fact.id,
    object_name: item.object.canonicalName,
    categories: item.object.categories,
    content: fact.content,
    trust: fact.trust,
    confirmations: fact.confirmations,
    confidence: fact.confidence,
    valid_until: fact.validUntil
  })));
}

function formatMemory(memory: CityMemorySearchResult[], objectLimit: number, factLimit: number): string {
  return memory.slice(0, objectLimit).map((item) => {
    const facts = item.knowledge.slice(0, factLimit).map((fact) => `- ${fact.content} [${fact.trust}; id=${fact.id}]`).join("\n");
    return `${item.object.canonicalName} (${item.object.categories.join(", ") || "без категории"})\n${facts}`;
  }).join("\n\n");
}

function formatHistory(channel: MaxEngagementChannelRecord, messages: MaxEngagementChatMessageRecord[], currentId: string, limit: number): string {
  return messages.filter((item) => item.id !== currentId).slice(-limit)
    .map((item) => `${displayAuthor(channel, item)}: ${item.text}`).join("\n");
}

function displayAuthor(channel: MaxEngagementChannelRecord, message: MaxEngagementChatMessageRecord): string {
  return message.authorName || (message.authorIsBot ? channelBotName(channel) || "Алина" : "Участница");
}

function channelBotName(channel: MaxEngagementChannelRecord): string {
  return channel.botName?.trim() || "Алина";
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

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
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
  format?: StructuredOutputFormat;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
        instructions: input.instructions,
        input: input.input,
        max_output_tokens: input.maxOutputTokens,
        temperature: input.temperature,
        text: input.format
          ? {
              format: {
                type: "json_schema",
                name: input.format.name,
                schema: input.format.schema,
                strict: true
              }
            }
          : undefined
      }),
      signal: controller.signal
    });
    const data = await response.json() as OpenAIResponse;
    if (!response.ok) throw new Error(data.error?.message || `OpenAI HTTP ${response.status}`);
    const text = extractText(data).trim();
    if (!text) throw new Error("OpenAI returned an empty response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(data: OpenAIResponse): string {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output ?? []).flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
}