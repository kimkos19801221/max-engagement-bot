import type { CityMemorySearchResult } from "../city-memory/types.js";
import type { MaxEngagementChannelRecord, MaxEngagementChatMessageRecord } from "./types.js";
import type { ContactDirectoryRecord } from "./contact-directory.js";
import { requestOpenAIResponses, type OpenAIResponsesData } from "./openai-responses.js";

type StructuredOutputFormat = {
  name: string;
  schema: Record<string, unknown>;
};

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
      should_search_contacts: { type: "boolean" },
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
    },
    required: [
      "message_type",
      "request_target",
      "request_scope",
      "action",
      "should_reply",
      "should_search_memory",
      "should_search_contacts",
      "category",
      "subcategory",
      "search_terms",
      "clarification_question",
      "risk",
      "risk_behavior",
      "already_answered_by_participants",
      "intervention_useful",
      "reason"
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
      used_contact_ids: { type: "array", items: { type: "string" } },
      attributes_to_unnamed_resident: { type: "boolean" },
      unsupported_local_claims: { type: "boolean" },
      reason: { type: "string" }
    },
    required: [
      "should_publish",
      "reply",
      "used_fact_ids",
      "used_contact_ids",
      "attributes_to_unnamed_resident",
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
  shouldSearchContacts: boolean;
  category: string;
  subcategory: string;
  searchTerms: string[];
  clarificationQuestion: string | null;
  risk: typeof RISKS[number];
  riskBehavior: typeof RISK_BEHAVIORS[number];
  alreadyAnsweredByParticipants: boolean;
  interventionUseful: boolean;
  reason: string;
};

export type CityAssistantReply = {
  shouldReply: boolean;
  text: string;
  safetyReason: string;
  usedFactIds: string[];
  usedContactIds?: string[];
  requestScope?: typeof REQUEST_SCOPES[number];
};

export function buildFallbackCityReply(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  reason: string;
}): CityAssistantReply {
  // Fail silent: if the main AI pipeline cannot produce a safe answer,
  // do not publish canned/template replies into the group chat.
  // Normal city-memory analysis/saving is handled by the main pipeline when it is available.
  return {
    shouldReply: false,
    text: "",
    safetyReason: `Fallback silent: ${input.reason}`,
    usedFactIds: []
  };
}


const AGENT_REPLY_FORMAT: StructuredOutputFormat = {
  name: "city_group_agent_decision",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      should_reply: { type: "boolean" },
      request_scope: { type: "string", enum: [...REQUEST_SCOPES] },
      reply: { type: "string" },
      used_fact_ids: { type: "array", items: { type: "string" } },
      used_contact_ids: { type: "array", items: { type: "string" } },
      reason: { type: "string" }
    },
    required: ["should_reply", "request_scope", "reply", "used_fact_ids", "used_contact_ids", "reason"]
  }
};

const GROUP_AGENT_PROMPT = [
  "Ты — Алина, ИИ-помощник внутри живого городского группового чата.",
  "Прочитай разговор целиком и сама реши, нужно ли вмешиваться. Не отвечай ради самого ответа.",
  "Отвечай только когда можешь заметно помочь: дать конкретную полезную информацию, практичный следующий шаг, понятное объяснение, релевантный сохранённый контакт или важное уточнение.",
  "Если участницы уже нормально ответили, разговор идёт сам, твой ответ будет очевидным, повторит вопрос или добавит только воду — should_reply=false.",
  "Пиши естественно, по-человечески и по делу. Не пересказывай вопрос перед ответом и не используй канцелярские фразы вроде «резидентка интересовалась».",
  "Не раскрывай внутренние слова базы: trust, fact_id, resident, source, memory. Если уместно указать происхождение единичной рекомендации, естественно скажи «в чате советовали» или «одна из участниц писала».",
  "ИСТОРИЯ ЧАТА — только контекст разговора. Она помогает понять, что уже сказано и нужен ли ответ, но НЕ является разрешённым источником конкретных местных фактов.",
  "РАЗРЕШЁННЫЕ ФАКТЫ ГОРОДА и РАЗРЕШЁННЫЕ КОНТАКТЫ — единственные источники конкретных местных сведений в твоём ответе.",
  "Для общих вопросов, не зависящих от города, используй общие знания и здравый смысл.",
  "Для local/mixed вопроса не выдумывай магазин, врача, организацию, адрес, телефон, цену, график, услугу или местное правило. Если полезного разрешённого факта/контакта нет — лучше промолчи.",
  "Если используешь местный факт, перечисли его id в used_fact_ids. Если используешь контакт, перечисли его id в used_contact_ids. Не указывай id, которых тебе не дали.",
  "Если выбираешь контакт, упомяни в reply его имя/категорию естественно; сама карточка контакта будет приложена сервером.",
  "У Алины нет собственной биографии, детей, родственников и личного опыта посещения мест или пользования услугами. Никогда не выдумывай такой опыт.",
  "В медицинских, юридических и финансовых темах можно давать полезную общую информацию и практичные безопасные шаги, но не придумывай локальные правила и не выдавай догадки за факт.",
  "Верни только JSON по заданной схеме."
].join("\n");

export async function decideCityReply(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
  replyToMessage?: MaxEngagementChatMessageRecord | null;
  memory: CityMemorySearchResult[];
  contacts: ContactDirectoryRecord[];
}): Promise<CityAssistantReply> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { shouldReply: false, text: "", safetyReason: "OpenAI API key is missing; chat reply skipped", usedFactIds: [], usedContactIds: [] };
  }

  const facts = flattenFacts(input.memory);
  const contacts = input.contacts.slice(0, 8).map((contact) => ({
    id: contact.id,
    category: contact.category,
    contact_name: contact.contactName,
    phone: contact.phone,
    times_shared: contact.timesShared
  }));

  const raw = await requestOpenAI({
    apiKey,
    maxOutputTokens: 900,
    temperature: 0.45,
    format: AGENT_REPLY_FORMAT,
    instructions: GROUP_AGENT_PROMPT,
    input: [
      `ГОРОДСКОЙ ЧАТ: ${input.channel.title}`,
      "ПОСЛЕДНИЕ СООБЩЕНИЯ ЧАТА (НЕПРОВЕРЕННЫЙ КОНТЕКСТ, НЕ ИСТОЧНИК ЛОКАЛЬНЫХ ФАКТОВ):",
      formatHistory(input.channel, input.recentMessages, input.message.id, 40) || "История отсутствует.",
      "СООБЩЕНИЕ, НА КОТОРОЕ ОТВЕЧАЮТ:",
      input.replyToMessage ? `${displayAuthor(input.channel, input.replyToMessage)}: ${input.replyToMessage.text}` : "нет",
      "РАЗРЕШЁННЫЕ ФАКТЫ ГОРОДА:",
      facts.length ? facts.map((fact) => JSON.stringify(fact)).join("\n") : "Фактов нет.",
      "РАЗРЕШЁННЫЕ КОНТАКТЫ ГОРОДА:",
      contacts.length ? contacts.map((contact) => JSON.stringify(contact)).join("\n") : "Контактов нет.",
      "ТЕКУЩЕЕ СООБЩЕНИЕ:",
      `${input.message.authorName || "Участница"}: ${input.message.text}`
    ].join("\n\n")
  });

  const parsed = parseAgentReply(raw);
  if (!parsed.shouldReply || !parsed.reply.trim()) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: `AI agent decision: ${parsed.reason}`,
      usedFactIds: [],
      usedContactIds: [],
      requestScope: parsed.requestScope
    };
  }

  const allowedFactIds = new Set(facts.map((fact) => fact.id));
  const allowedContactIds = new Set(input.contacts.map((contact) => contact.id));
  if (parsed.usedFactIds.some((id) => !allowedFactIds.has(id))) {
    throw new Error("AI agent referenced a fact that was not supplied by the server");
  }
  if (parsed.usedContactIds.some((id) => !allowedContactIds.has(id))) {
    throw new Error("AI agent referenced a contact that was not supplied by the server");
  }

  const effectiveScope = isExplicitLocalLookupRequest(input.message.text) ? "local" : parsed.requestScope;
  if (effectiveScope !== "global" && parsed.usedFactIds.length === 0 && parsed.usedContactIds.length === 0) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Local/mixed reply blocked: no grounded fact or contact selected",
      usedFactIds: [],
      usedContactIds: [],
      requestScope: effectiveScope
    };
  }

  if (containsUnsupportedResidentAttribution(parsed.reply, parsed.usedFactIds, facts)) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Reply blocked: attribution to resident/participant not backed by a single_resident-trust fact",
      usedFactIds: [],
      usedContactIds: [],
      requestScope: effectiveScope
    };
  }

  if (containsFabricatedPersonalExperience(parsed.reply)) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Reply blocked: fabricated personal experience/biography",
      usedFactIds: [],
      usedContactIds: [],
      requestScope: effectiveScope
    };
  }

  return {
    shouldReply: true,
    text: parsed.reply.slice(0, 1800),
    safetyReason: `AI agent decision: ${parsed.reason}`,
    usedFactIds: parsed.usedFactIds,
    usedContactIds: parsed.usedContactIds,
    requestScope: effectiveScope
  };
}

function parseAgentReply(text: string): {
  shouldReply: boolean;
  requestScope: typeof REQUEST_SCOPES[number];
  reply: string;
  usedFactIds: string[];
  usedContactIds: string[];
  reason: string;
} {
  const value = parseStrictJson(text);
  assertOnlyKeys(value, ["should_reply", "request_scope", "reply", "used_fact_ids", "used_contact_ids", "reason"], "city group agent decision");
  return {
    shouldReply: booleanValue(value.should_reply, "should_reply"),
    requestScope: enumValue(value.request_scope, REQUEST_SCOPES, "request_scope"),
    reply: stringValue(value.reply, "reply", 4000),
    usedFactIds: stringArray(value.used_fact_ids, "used_fact_ids", 20, 200),
    usedContactIds: stringArray(value.used_contact_ids, "used_contact_ids", 10, 200),
    reason: stringValue(value.reason, "reason", 600)
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
      "СООБЩЕНИЕ, НА КОТОРОЕ ОТВЕЧАЮТ (НЕПРОВЕРЕННЫЙ КОНТЕКСТ, НЕ ФАКТ):",
      input.replyToMessage ? `${displayAuthor(input.channel, input.replyToMessage)}: ${input.replyToMessage.text}` : "нет",
      "ПОСЛЕДНИЕ СООБЩЕНИЯ ЧАТА (НЕПРОВЕРЕННЫЙ КОНТЕКСТ, НЕ ИСТОЧНИК ФАКТОВ):",
      history || "История отсутствует.",
      "КРАТКАЯ РЕЛЕВАНТНАЯ ПАМЯТЬ ГОРОДА:",
      memoryPreview || "Подходящей памяти пока нет.",
      "ТЕКУЩЕЕ СООБЩЕНИЕ:",
      `${input.message.authorName || "Участница"}: ${input.message.text}`
    ].join("\n\n")
  });

  const plan = parsePlan(raw);
  return applyDeterministicLocalLookupOverride(plan, input.message.text);
}

export async function generateCityReply(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
  plan: CityAssistantPlan;
  memory: CityMemorySearchResult[];
  contacts: ContactDirectoryRecord[];
}): Promise<CityAssistantReply> {
  if (!input.plan.shouldReply) {
    return { shouldReply: false, text: "", safetyReason: `AI plan: ${input.plan.reason}`, usedFactIds: [] };
  }

  const facts = flattenFacts(input.memory);
  const contacts = input.contacts.slice(0, 8).map((contact) => ({
    id: contact.id,
    category: contact.category,
    contact_name: contact.contactName,
    phone: contact.phone,
    times_shared: contact.timesShared
  }));

  // Hard server-side grounding gate: any answer with a local component must have
  // retrieved city-memory facts. Prefer silence to a plausible but unsupported claim.
  if (input.plan.requestScope !== "global" && facts.length === 0 && contacts.length === 0) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Local/mixed request blocked: no retrieved city facts or contacts",
      usedFactIds: [],
      usedContactIds: []
    };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { shouldReply: false, text: "", safetyReason: "OpenAI API key is missing; chat reply skipped", usedFactIds: [] };
  }

  const raw = await requestOpenAI({
    apiKey,
    maxOutputTokens: 650,
    temperature: 0.35,
    format: FINAL_REPLY_FORMAT,
    instructions: FINAL_REPLY_PROMPT,
    input: [
      `ЧАТ: ${input.channel.title}`,
      `РЕШЕНИЕ ОРКЕСТРАТОРА: ${JSON.stringify(planToFinalPromptRecord(input.plan))}`,
      "ПОСЛЕДНИЕ СООБЩЕНИЯ (только контекст разговора, не источник местных фактов):",
      formatHistory(input.channel, input.recentMessages, input.message.id, 20) || "История отсутствует.",
      "РАЗРЕШЁННЫЕ ФАКТЫ ИЗ ГОРОДСКОЙ ПАМЯТИ:",
      facts.length ? facts.map((fact) => JSON.stringify(fact)).join("\n") : "Фактов нет.",
      "РАЗРЕШЁННЫЕ КОНТАКТЫ:",
      contacts.length ? contacts.map((contact) => JSON.stringify(contact)).join("\n") : "Контактов нет.",
      "ИСХОДНОЕ СООБЩЕНИЕ:",
      `${input.message.authorName || "Участница"}: ${input.message.text}`
    ].join("\n\n")
  });

  const parsed = parseFinalReply(raw);
  if (!parsed.shouldPublish || !parsed.reply.trim()) {
    return { shouldReply: false, text: "", safetyReason: `AI final decision: ${parsed.reason}`, usedFactIds: [], usedContactIds: [] };
  }

  const allowedIds = new Set(facts.map((fact) => fact.id));
  const allowedContactIds = new Set(input.contacts.map((contact) => contact.id));
  if (parsed.usedFactIds.some((id) => !allowedIds.has(id))) {
    throw new Error("Final AI reply referenced a fact that was not supplied by the server");
  }
  if (parsed.usedContactIds.some((id) => !allowedContactIds.has(id))) {
    throw new Error("Final AI reply referenced a contact that was not supplied by the server");
  }

  // A local/mixed answer must explicitly ground itself in at least one supplied fact.
  // The model cannot publish a local answer with used_fact_ids: [].
  if (input.plan.requestScope !== "global" && parsed.usedFactIds.length === 0 && parsed.usedContactIds.length === 0) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Local/mixed reply blocked: no used fact or contact IDs",
      usedFactIds: [],
      usedContactIds: []
    };
  }

  // Independent server-side protection against fabricated attribution to unnamed
  // local sources (for example, "как упоминал один из резидентов"). This applies
  // regardless of request_scope, including global answers.
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const hasResidentSourcedFact = parsed.usedFactIds.some((id) => factsById.get(id)?.trust === "single_resident");
  if ((parsed.attributesToUnnamedResident || containsUnsupportedResidentAttribution(parsed.reply, parsed.usedFactIds, facts)) && !hasResidentSourcedFact) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Reply blocked: attribution to resident/participant not backed by a single_resident-trust fact",
      usedFactIds: [],
      usedContactIds: []
    };
  }

  // Independent server-side protection against invented biography/personal experience.
  if (containsFabricatedPersonalExperience(parsed.reply)) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Reply blocked: fabricated personal experience/biography",
      usedFactIds: [],
      usedContactIds: []
    };
  }

  return {
    shouldReply: true,
    text: parsed.reply.slice(0, 1800),
    safetyReason: `AI final decision: ${parsed.reason}`,
    usedFactIds: parsed.usedFactIds,
    usedContactIds: parsed.usedContactIds,
    requestScope: input.plan.requestScope
  };
}

const ORCHESTRATOR_PROMPT = [
  "Ты — оркестратор городского ИИ-помощника Алины в групповом чате для мам.",
  "Алина — ИИ-помощник без личной биографии, родственников, детей, посещений организаций и собственного бытового опыта.",
  "Сначала пойми социальный смысл текущей реплики, её адресата и связь с предыдущими сообщениями. Не принимай решение по отдельным словам или вопросительному знаку.",
  "Алина — спокойный полезный помощник, а не обязательный участник каждого обсуждения. Вмешивайся только когда ответ уместен и добавит новую практическую ценность. Если сомневаешься — молчи.",
  "Сообщения участниц в истории — непроверенный контекст разговора. Их нельзя считать подтверждёнными фактами, присваивать Алине или превращать в личный опыт Алины.",
  "Отвечай, когда сообщение явно адресовано Алине, а также на явные вопросы всему чату, только если Алина действительно может помочь.",
  "Для local-вопроса всему чату выбирай should_search_memory=true. Если подходящих фактов городской памяти нет, итоговый серверный гейт заставит Алину промолчать.",
  "Если участница действительно просит найти или посоветовать местного специалиста/услугу/контакт, выбирай should_search_contacts=true. Само слово «контакт» не является причиной искать или отвечать.",
  "Упоминание имени Алина само по себе не означает запрос: благодарность, обсуждение Алины и обычная реплика могут требовать молчания.",
  "Для каждого запроса определи request_scope: local, global или mixed.",
  "local — ответ зависит от конкретного города, конкретной местной организации или объекта: врачи, садики, школы, магазины, мастера, услуги, организации, адреса, телефоны, графики, события, отключения, цены, условия приёма конкретной школы и другие местные сведения. Формулировки «где купить», «где можно купить», «где найти», «где можно найти», «где продают», «где заказать», «где можно заказать», «куда обратиться», «кто делает», «кто продаёт» в контексте города — это тоже local, даже если сам предмет запроса не выглядит специфично городским. Для local нужны факты городской памяти.",
  "global — вопрос не зависит от города или конкретной местной организации. Для global не ищи городскую память: should_search_memory=false. Если сообщение адресовано Алине и безопасно, можно отвечать из общих знаний модели.",
  "mixed — вопрос сочетает общую и локальную часть. Для публикации mixed-ответа также нужны факты городской памяти, потому что ответ может быть воспринят как локальная рекомендация или локальное правило.",
  "Не выдумывай организации, врачей, адреса, телефоны, цены, графики, документы, услуги, отзывы, правила конкретных учреждений или поведение их сотрудников.",
  "Не говори от имени Алины «из моего опыта», «у меня сын/дочь/племянник», «я лично обращалась/ходила/училась/покупала» и не присваивай Алине истории участниц.",
  "Не вмешивайся в обычную болтовню и реплики конкретным участницам без явного запроса.",
  "Если участницы уже дали содержательный ответ, обычно промолчи; полезный новый локальный факт можно сохранить молча.",
  "При риске personal_data, accusation или unverified_treatment выбирай silent либо moderation_review. При обычном медицинском запросе можно выбрать careful_reply, но не сохраняй медицинскую историю конкретного человека.",
  "Верни строго один JSON-объект без markdown и лишнего текста со всеми полями:",
  JSON.stringify({
    message_type: "request|shared_experience|response_to_bot|casual|sensitive|technical",
    request_target: "bot|whole_chat|specific_participant|unclear|none",
    request_scope: "local|global|mixed",
    action: "ignore|clarify|search|save|search_and_save|reply_without_search",
    should_reply: false,
    should_search_memory: false,
    should_search_contacts: false,
    category: "короткая категория или пустая строка",
    subcategory: "короткая подкатегория или пустая строка",
    search_terms: ["поисковая формулировка"],
    clarification_question: null,
    risk: "none|medical|personal_data|accusation|advertising|unverified_treatment|other",
    risk_behavior: "normal|silent|careful_reply|moderation_review",
    already_answered_by_participants: false,
    intervention_useful: false,
    reason: "краткая причина для журнала"
  }),
  "На этом этапе не формируй ответ и не извлекай факты для памяти: твоя задача — только понять разговор и решить, уместно ли вмешиваться."
].join("\n");

const FINAL_REPLY_PROMPT = [
  "Ты формируешь окончательный ответ городского ИИ-помощника Алины.",
  "Алина — ИИ. У неё нет личной биографии, родственников, детей, знакомых, собственного опыта посещения школ, врачей, магазинов, организаций или использования услуг.",
  "Никогда не присваивай Алине опыт участниц и не пиши «из моего опыта», «у меня сын/дочь/племянник», «я лично ходила/обращалась/училась/покупала» и подобные заявления.",
  "Никогда не приписывай утверждение участнице, резиденту, жителю или чату, если конкретный использованный факт не имеет trust=single_resident. Если данных нет, нельзя писать «как упоминал один из резидентов», «в чате советовали», «одна из участниц рекомендовала», «по словам местных» и аналогичные формулировки. Не создавай источник или атрибуцию для заполнения пробела в данных.",
  "Для local и mixed любые конкретные местные утверждения разрешены только из списка РАЗРЕШЁННЫХ ФАКТОВ ИЗ ГОРОДСКОЙ ПАМЯТИ.",
  "Если request_scope=local или mixed, каждый опубликованный ответ обязан опираться хотя бы на один переданный факт или релевантный контакт и указать его id. Иначе should_publish=false.",
  "Для запроса специалиста local/mixed можно опереться на релевантный разрешённый контакт: укажи его id в used_contact_ids. Наличие контакта само по себе не является причиной отвечать.",
  "Если в тексте ссылаешься на неназванного жителя, участницу или чат, установи attributes_to_unnamed_resident=true.",
  "Не используй исходное сообщение пользователя как доказательство местных фактов. Оно показывает только запрос.",
  "Для global разрешены общие знания модели, но их нельзя выдавать за сведения о конкретной местной школе, враче, организации, услуге или другом объекте.",
  "Если фактов и контактов недостаточно для безопасного local/mixed ответа, выбери should_publish=false. Не публикуй шаблонный ответ об отсутствии данных и не проси чат дополнить базу.",
  "Если участницы уже полноценно ответили или ответ Алины будет лишним, выбери should_publish=false.",
  "Пиши естественно и коротко, но как ИИ-помощник, а не как человек с вымышленной жизнью.",
  "Факт single_resident называй упоминанием, рекомендацией или опытом участницы, а не проверенной информацией.",
  "Не добавляй локальных деталей, которых нет в разрешённых фактах, даже если они кажутся правдоподобными.",
  "Верни строго JSON без markdown: {\"should_publish\":boolean,\"reply\":string,\"used_fact_ids\":string[],\"used_contact_ids\":string[],\"attributes_to_unnamed_resident\":boolean,\"unsupported_local_claims\":boolean,\"reason\":string}.",
  "Если есть хотя бы одно неподтверждённое локальное утверждение, установи unsupported_local_claims=true, should_publish=false и reply пустую строку."
].join("\n");

// The final-answer model receives compact decision metadata. Recent history is supplied
// only to preserve conversational naturalness and must never ground local claims.
function planToFinalPromptRecord(plan: CityAssistantPlan): Record<string, unknown> {
  return {
    request_target: plan.requestTarget,
    request_scope: plan.requestScope,
    category: plan.category,
    subcategory: plan.subcategory,
    already_answered_by_participants: plan.alreadyAnsweredByParticipants,
    intervention_useful: plan.interventionUseful
  };
}

function parsePlan(text: string): CityAssistantPlan {
  const value = parseStrictJson(text);

  if (!("search_terms" in value)) value.search_terms = [];
  if (!("clarification_question" in value)) value.clarification_question = null;

  assertOnlyKeys(value, [
    "message_type", "request_target", "request_scope", "action", "should_reply", "should_search_memory", "should_search_contacts",
    "category", "subcategory", "search_terms", "clarification_question", "risk", "risk_behavior",
    "already_answered_by_participants", "intervention_useful", "reason"
  ], "orchestrator decision");

  const action = enumValue(value.action, ACTIONS, "action");
  const messageType = enumValue(value.message_type, MESSAGE_TYPES, "message_type");
  const requestTarget = enumValue(value.request_target, TARGETS, "request_target");
  const requestScope = enumValue(value.request_scope, REQUEST_SCOPES, "request_scope");
  const risk = enumValue(value.risk, RISKS, "risk");
  const riskBehavior = enumValue(value.risk_behavior, RISK_BEHAVIORS, "risk_behavior");

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
  let shouldSearchContacts = booleanValue(value.should_search_contacts, "should_search_contacts");
  if (unsafeRisk || !shouldReply) {
    shouldSearchContacts = false;
  }

  return {
    messageType,
    requestTarget,
    requestScope,
    action,
    shouldReply,
    shouldSearchMemory,
    shouldSearchContacts,
    category: stringValue(value.category, "category", 120),
    subcategory: stringValue(value.subcategory, "subcategory", 120),
    searchTerms: stringArray(value.search_terms, "search_terms", 12, 160),
    clarificationQuestion: nullableString(value.clarification_question, "clarification_question", 400),
    risk,
    riskBehavior,
    alreadyAnsweredByParticipants: booleanValue(value.already_answered_by_participants, "already_answered_by_participants"),
    interventionUseful: booleanValue(value.intervention_useful, "intervention_useful"),
    reason: stringValue(value.reason, "reason", 500)
  };
}

function parseFinalReply(text: string): { shouldPublish: boolean; reply: string; usedFactIds: string[]; usedContactIds: string[]; attributesToUnnamedResident: boolean; reason: string } {
  const value = parseStrictJson(text);
  assertOnlyKeys(value, ["should_publish", "reply", "used_fact_ids", "used_contact_ids", "attributes_to_unnamed_resident", "unsupported_local_claims", "reason"], "final reply");
  const unsupported = booleanValue(value.unsupported_local_claims, "unsupported_local_claims");
  const shouldPublish = booleanValue(value.should_publish, "should_publish") && !unsupported;
  return {
    shouldPublish,
    reply: stringValue(value.reply, "reply", 1800),
    usedFactIds: stringArray(value.used_fact_ids, "used_fact_ids", 30, 100),
    usedContactIds: stringArray(value.used_contact_ids, "used_contact_ids", 10, 200),
    attributesToUnnamedResident: booleanValue(value.attributes_to_unnamed_resident, "attributes_to_unnamed_resident"),
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
    .map((item) => `[НЕПРОВЕРЕННОЕ СООБЩЕНИЕ] ${displayAuthor(channel, item)}: ${item.text}`).join("\n");
}

function displayAuthor(channel: MaxEngagementChannelRecord, message: MaxEngagementChatMessageRecord): string {
  return message.authorName || (message.authorIsBot ? channelBotName(channel) || "Алина" : "Участница");
}

function channelBotName(channel: MaxEngagementChannelRecord): string {
  return channel.botName?.trim() || "Алина";
}

// KNOWN LIMITATION:
// This only verifies that at least one cited used_fact_id has trust=single_resident.
// It does NOT verify that the cited fact is topically related to this attribution.
// Fully closing that gap would require a separate resident_attribution_fact_ids
// field from the model and a server-side subset/trust validation.
export function containsUnsupportedResidentAttribution(
  text: string,
  usedFactIds: string[],
  facts: Array<{ id: string; trust: string }>
): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  const attributionPatterns = [
    /(?:^|[^\p{L}\p{N}])как (?:упоминал\p{L}*|советовал\p{L}*|рекомендовал\p{L}*|писал\p{L}*|говорил\p{L}*|отмечал\p{L}*|делил\p{L}*|рассказывал\p{L}*) (?:один из резидентов|одна из участниц|одна из жительниц(?: города)?|кто-то из участниц|кто-то из резидентов|кто-то)(?=[^\p{L}\p{N}]|$)/u,
    /(?:^|[^\p{L}\p{N}])(?:один из резидентов|одна из участниц|кто-то из участниц|кто-то из резидентов|участницы|резиденты) (?:упоминал\p{L}*|советовал\p{L}*|рекомендовал\p{L}*|писал\p{L}*|говорил\p{L}*)(?=[^\p{L}\p{N}]|$)/u,
    /(?:^|[^\p{L}\p{N}])(?:в чате|здесь) (?:писал\p{L}*|советовал\p{L}*|рекомендовал\p{L}*|упоминал\p{L}*)(?=[^\p{L}\p{N}]|$)/u,
    /(?:^|[^\p{L}\p{N}])по словам (?:резидентов|участниц|местных)(?=[^\p{L}\p{N}]|$)/u
  ];

  if (!attributionPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const usedResidentFacts = usedFactIds.filter((id) => factsById.get(id)?.trust === "single_resident");
  return usedResidentFacts.length === 0;
}

// Deterministic override for the LLM's own local/global classification.
// Prompt instructions are not guaranteed: explicit "where can I buy/find/order",
// "where should I go", and "who sells/does" queries are local lookups even if the
// requested item itself is generic.
export function isExplicitLocalLookupRequest(text: string): boolean {
  const end = String.raw`(?=[^\p{L}\p{N}]|$)`;
  const patterns = [
    new RegExp(String.raw`(?:^|\s)(?:где\s+(?:можно\s+)?(?:купить|найти|заказать|продают)|куда\s+обратиться|кто\s+(?:делает|прода[её]т|оказывает)|как\s+(?:добраться|проехать))${end}`, "iu"),
    new RegExp(String.raw`(?:^|\s)где\s[\s\S]{0,60}?(?:^|\s)(?:наход(?:ится|ятся)|располож(?:ен|ена|ено|ены))${end}`, "iu"),
    new RegExp(String.raw`(?:^|\s)по\s+какому\s+адресу${end}`, "iu"),
    new RegExp(String.raw`(?:^|\s)есть\s+ли\s+(?:у\s+нас|в\s+нашем\s+городе)${end}`, "iu")
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function applyDeterministicLocalLookupOverride(
  plan: CityAssistantPlan,
  messageText: string
): CityAssistantPlan {
  if (plan.requestScope !== "global") return plan;
  if (!isExplicitLocalLookupRequest(messageText)) return plan;

  // requestScope alone is not enough: shouldSearchMemory was already computed
  // from the LLM's original "global" classification, so force memory search too.
  return { ...plan, requestScope: "local", shouldSearchMemory: true };
}

function containsFabricatedPersonalExperience(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  // JavaScript \b/\w are ASCII-oriented and do not give reliable word boundaries
  // for Cyrillic. Use Unicode letter/number classes instead.
  const start = String.raw`(?:^|[^\p{L}\p{N}])`;
  const end = String.raw`(?=[^\p{L}\p{N}]|$)`;

  // Explicit Russian noun forms avoid the same Cyrillic bug that \w* would have.
  // The goal is not linguistic completeness; this is a last-resort server-side guard
  // in addition to the stronger grounding gates above.
  const relative = [
    String.raw`сын(?:а|у|ом|е|ов|овья|овей|овьям|овьями|овьях)?`,
    String.raw`доч(?:ь|ери|ерью|ерей|ерям|ерьми|ерях)`,
    String.raw`дет(?:и|ей|ям|ьми|ях)`,
    String.raw`реб[её]н(?:ок|ка|ку|ком|ке|ки|ков|кам|ками|ках)`,
    String.raw`муж(?:а|у|ем|е|ья|ей|ьям|ьями|ьях)?`,
    String.raw`жен(?:а|ы|е|у|ой|ою|ам|ами|ах)`,
    String.raw`мам(?:а|ы|е|у|ой|ою|ам|ами|ах)`,
    String.raw`пап(?:а|ы|е|у|ой|ою|ам|ами|ах)`,
    String.raw`племянник(?:а|у|ом|е|и|ов|ам|ами|ах)?`,
    String.raw`племянниц(?:а|ы|е|у|ей|ам|ами|ах)`,
    String.raw`внук(?:а|у|ом|е|и|ов|ам|ами|ах)?`,
    String.raw`внуч(?:ка|ки|ке|ку|кой|ек|кам|ками|ках)`
  ].join("|");

  const patterns = [
    new RegExp(`${start}из моего опыта${end}`, "u"),
    new RegExp(`${start}по моему(?: личному)? опыту${end}`, "u"),
    new RegExp(`${start}у меня (?:есть )?(?:${relative})${end}`, "u"),
    new RegExp(`${start}(?:мой|моя|мои|моего|моей|моему|моим|моими) (?:${relative})${end}`, "u"),
    new RegExp(
      String.raw`${start}я лично (?:ходил\p{L}*|обращал\p{L}*|учил\p{L}*|покупал\p{L}*|пользовал\p{L}*|водил\p{L}*|лечил\p{L}*|был\p{L}*)${end}`,
      "u"
    ),
    new RegExp(
      `${start}мы с (?:мужем|женой|детьми|сыном|дочерью|реб[её]нком)${end}`,
      "u"
    )
  ];

  return patterns.some((pattern) => pattern.test(normalized));
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
    const data = await requestOpenAIResponses({
      apiKey: input.apiKey,
      payload: {
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
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output ?? []).flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
    }
