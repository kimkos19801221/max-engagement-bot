import type {
  MaxEngagementChannelRecord,
  MaxEngagementChatMessageRecord,
  MaxEngagementCommentRecord,
  MaxEngagementDecision,
  MaxEngagementGeneratedDraft,
  MaxEngagementPostRecord
} from "./types.js";
import type { CityMemorySearchResult } from "../city-memory/types.js";
import { requestOpenAIResponses, type OpenAIResponsesData } from "./openai-responses.js";

const DEFAULT_MODEL = "gpt-4.1-mini";

const ADMIN_LIKE_INITIATIVE_PATTERNS = [
  /\bдевочки\b/i,
  /\bкто сталкивался\b/i,
  /\bу кого было похож/i,
  /\bделитесь\b/i,
  /\bподелитесь опытом\b/i,
  /\bнапишите свой опыт\b/i,
  /\bрасскажите\b/i,
  /\bкак остальные думают\b/i,
  /\bчто думаете по этому поводу\b/i,
  /\bдавайте обсудим\b/i,
  /\bжд[её]м ваши/i
];

export async function generateDryRunDraft(input: {
  channel: MaxEngagementChannelRecord;
  comment: MaxEngagementCommentRecord;
  decision: MaxEngagementDecision;
  post: MaxEngagementPostRecord | null;
}): Promise<MaxEngagementGeneratedDraft> {
  const { channel, comment, decision, post } = input;

  if (decision.actionType === "stop_thread") {
    return {
      text: "",
      safetyReason: `${decision.reason}; public reply skipped`
    };
  }

  if (decision.actionType === "moderate") {
    return {
      text: "",
      safetyReason: `${decision.reason}; moderation action only`
    };
  }

  const fallback = fallbackCommentDraft(input);
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    return fallback;
  }

  try {
    const generated = await requestOpenAI({
      apiKey,
      instructions: buildReplyInstructions(
        channel,
        decision.finalTeasingLevel
      ),
      input: [
        `Тип паблика: ${
          channel.channelKind === "moms"
            ? "родительское сообщество"
            : "новостной паблик"
        }.`,
        `Классификация поста: ${post?.classification ?? "unknown"}.`,
        `Текст поста: ${post?.text?.trim() || "не указан"}`,
        `Комментарий подписчика (${
          comment.authorName?.trim() || "без имени"
        }): ${comment.text.trim()}`,
        `Нужный уровень подкола: ${decision.finalTeasingLevel}.`,
        "Напиши только готовый ответ без кавычек, пояснений и служебного текста."
      ].join("\n")
    });

    return {
      text: appendSignature(generated, channel),
      safetyReason:
        `OpenAI contextual reply; teasing level ${decision.finalTeasingLevel}`
    };
  } catch (error) {
    return {
      ...fallback,
      safetyReason:
        `${fallback.safetyReason}; OpenAI fallback: ${
          error instanceof Error ? error.message : String(error)
        }`
    };
  }
}

export async function generatePostInitiativeDraft(input: {
  channel: MaxEngagementChannelRecord;
  decision: MaxEngagementDecision;
  post: MaxEngagementPostRecord;
}): Promise<MaxEngagementGeneratedDraft> {
  const { channel, decision, post } = input;
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  /*
   * Для инициативного комментария больше не используем
   * заранее прописанные фразы. Если GPT недоступен,
   * безопаснее ничего не публиковать.
   */
  if (!apiKey) {
    return {
      text: "",
      safetyReason: "OpenAI API key is missing; initiative skipped"
    };
  }

  try {
    const generated = await requestOpenAI({
      apiKey,
      instructions: buildInitiativeInstructions(
        channel,
        decision.finalTeasingLevel,
        post.classification
      ),
      input: [
        `Тип сообщества: ${
          channel.channelKind === "moms"
            ? "родительское сообщество"
            : "городской новостной паблик"
        }.`,
        `Классификация публикации: ${post.classification}.`,
        `Текст публикации администратора:\n${post.text?.trim() || "не указан"}`,
        "",
        "Напиши один самостоятельный комментарий обычного подписчика.",
        "Не повторяй вопрос или просьбу автора публикации.",
        "Не призывай всю группу отвечать.",
        "Не добавляй подпись, имя или роль.",
        "Если полезного и естественного комментария нет, верни ровно: NO_REPLY"
      ].join("\n")
    });

    const clean = cleanInitiativeText(generated);

    if (!clean) {
      return {
        text: "",
        safetyReason: "OpenAI initiative returned NO_REPLY or empty text"
      };
    }

    /*
     * Дополнительная защита от ответа в стиле администратора.
     * Такие ответы не публикуются.
     */
    if (looksLikeAdminInitiative(clean)) {
      return {
        text: "",
        safetyReason:
          "OpenAI initiative rejected: sounds like an administrator or repeats a group call-to-action"
      };
    }

    return {
      /*
       * ВАЖНО: здесь намеренно нет appendSignature().
       * Инициативный текст должен выглядеть как комментарий подписчика.
       */
      text: clean,
      safetyReason:
        `OpenAI subscriber-style initiative; teasing level ${decision.finalTeasingLevel}`
    };
  } catch (error) {
    /*
     * При ошибке GPT не публикуем старый шаблон.
     */
    return {
      text: "",
      safetyReason:
        `OpenAI initiative skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
    };
  }
}


export type CityAssistantDraft = {
  shouldReply: boolean;
  text: string;
  safetyReason: string;
};

const LOCAL_RECOMMENDATION_REQUEST_PATTERNS = [
  /\b(?:подскаж(?:ите|и)|посовет(?:уйте|уй)|порекоменду(?:йте|й))\b[^.!?]{0,120}\b(?:где|кто|кого|что|контакт|номер|адрес|заказать|найти|взять|купить|обратиться)\b/iu,
  /\bгде\s+(?:можно\s+)?(?:найти|заказать|купить|взять|сделать|арендовать|оформить|записаться)\b/iu,
  /\bкто\s+(?:делает|занимается|сдает|сдаёт|изготавливает|оказывает|может|знает)\b/iu,
  /\bищу\b[^.!?]{2,120}/iu,
  /\bнуж(?:ен|на|но|ны)\b[^.!?]{2,120}/iu,
  /\b(?:есть|дайте|скиньте|поделитесь)\b[^.!?]{0,80}\b(?:контакт|номер|адрес|рекомендаци|вариант)\b/iu,
  /\bкто[- ]нибудь\s+(?:заказывал|обращался|пользовался|знает)\b/iu
];

const SHORT_REACTION_PATTERNS = [
  /^(?:спасибо|спасибочки|благодарю|понятно|ясно|хорошо|ок(?:ей)?|ага|да|нет|точно|согласна|согласен)[!., )]*(?:[🙂😊🙏👍❤❤️]+)?$/iu,
  /^[🙂😊🙏👍❤❤️👌👏]+$/u
];

function isLocalRecommendationRequest(text: string): boolean {
  const compactText = text.replace(/\s+/gu, " ").trim();
  return LOCAL_RECOMMENDATION_REQUEST_PATTERNS.some((pattern) => pattern.test(compactText));
}

function isShortReaction(text: string): boolean {
  const compactText = text.replace(/\s+/gu, " ").trim();
  return compactText.length <= 40 && SHORT_REACTION_PATTERNS.some((pattern) => pattern.test(compactText));
}

export async function generateCityAssistantDraft(input: {
  channel: MaxEngagementChannelRecord;
  message: MaxEngagementChatMessageRecord;
  recentMessages: MaxEngagementChatMessageRecord[];
  memory: CityMemorySearchResult[];
}): Promise<CityAssistantDraft> {
  if (isShortReaction(input.message.text)) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "Short reaction does not require a reply"
    };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: "OpenAI API key is missing; chat reply skipped"
    };
  }

  /*
   * Для запросов на местные рекомендации без проверенных данных
   * не обращаемся к модели: так исключаются выдуманные клиники,
   * специалисты, адреса, контакты и отзывы.
   */
  if (
    input.memory.length === 0 &&
    isLocalRecommendationRequest(input.message.text)
  ) {
    return {
      shouldReply: true,
      text:
        "В моей базе пока нет проверенной рекомендации. Поделитесь, пожалуйста, контактами из личного опыта — подходящие варианты я добавлю в свою базу для будущих обращений.",
      safetyReason:
        "Local recommendation requested, but verified city memory is empty"
    };
  }

  const conversation = input.recentMessages
    .filter((item) => item.id !== input.message.id)
    .slice(-20)
    .map((item) => `${item.authorName || (item.authorIsBot ? input.channel.botName || "Алина" : "Участник")}: ${item.text}`)
    .join("\n");

  const timeZone =
    process.env.CHAT_TIME_ZONE?.trim() ||
    process.env.TZ?.trim() ||
    "Asia/Seoul";
  const now = new Date();
  const currentDateTime = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short"
  }).format(now);

  const memoryText = input.memory.length === 0
    ? "Релевантных сведений в городской памяти не найдено."
    : input.memory.slice(0, 6).map((item, index) => {
        const facts = item.knowledge.slice(0, 5).map((fact) => `- ${fact.content} [доверие: ${fact.trust}, подтверждений: ${fact.confirmations}]`).join("\n");
        return `${index + 1}. ${item.object.canonicalName}\n${facts}`;
      }).join("\n\n");

  try {
    const raw = await requestOpenAI({
      apiKey,
      instructions: [
        "Ты Алина — ИИ-помощник внутри русскоязычного городского чата для мам.",
        "Всегда называй городскую базу своей: «в моей базе», «я добавлю в свою базу», «я сохраню в своей базе». Не говори «в нашей базе», «мы добавим», «добавим в городскую базу» или «в базе сообщества».",
        "Не начинай ответ с имени пользователя. Не обращайся по имени без необходимости. Используй имя только изредка, когда это действительно естественно по контексту.",
        "Если пользователь просит порекомендовать конкретного местного специалиста, организацию, услугу или место, а в городской памяти нет проверенного варианта, не выдумывай названия и не давай общие советы вроде «обратитесь в крупную клинику». Честно скажи, что в моей базе пока нет проверенной рекомендации, и попроси участников чата поделиться контактами или личным опытом. Уточни, что подходящие ответы я смогу добавить в свою базу для будущих обращений.",
        "Для локальных рекомендаций используй только сведения из городской памяти с достаточной уверенностью. Если данных нет или они сомнительные, задай сообществу короткий естественный вопрос и не называй организации от себя.",
        "Веди себя как обычный ChatGPT в естественном диалоге.",
        "Сам реши, уместно ли отвечать на ТЕКУЩЕЕ СООБЩЕНИЕ. История дана только для понимания контекста; не отвечай вместо текущего сообщения на старую реплику.",
        "Никогда не придумывай названия клиник, врачей, организаций, адреса, телефоны, графики работы и другие локальные факты. Любую конкретную местную рекомендацию можно называть только тогда, когда она прямо присутствует в переданной городской памяти.",
        "Если в городской памяти нет проверенного ответа, не называй никаких конкретных организаций и не используй формулировки вроде «часто рекомендуют», «обычно обращаются» или «есть хорошие отзывы». Скажи, что проверенной рекомендации в моей базе пока нет, и попроси участников поделиться личным опытом, чтобы я могла добавить подходящие варианты в свою базу.",
        "Даже если название организации кажется типичным или вероятным, запрещено выводить его без источника из городской памяти.",
        "Для слов «сегодня», «завтра», «вчера», дат, времени и дня недели используй переданные ниже текущие дату, время и часовой пояс. Не угадывай и не используй сведения о дате из старой истории чата.",
        "Используй городскую память только как дополнительный контекст и не выдавай непроверенные местные сведения за достоверные.",
        "Верни только JSON без markdown: {\"should_reply\":boolean,\"reason\":string,\"reply\":string}."
      ].join("\n"),
      input: [
        `Чат: ${input.channel.title}`,
        `ТЕКУЩИЕ ДАТА И ВРЕМЯ: ${currentDateTime}`,
        `ЧАСОВОЙ ПОЯС: ${timeZone}`,
        "ИСТОРИЯ ДО ТЕКУЩЕГО СООБЩЕНИЯ:",
        conversation || "История отсутствует.",
        "ГОРОДСКАЯ ПАМЯТЬ:",
        memoryText,
        "ТЕКУЩЕЕ СООБЩЕНИЕ:",
        `${input.message.authorName || "Участник"}: ${input.message.text}`
      ].join("\n\n")
    });

    const parsed = parseCityAssistantJson(raw);
    return {
      shouldReply: parsed.should_reply && Boolean(parsed.reply.trim()),
      text: parsed.should_reply ? parsed.reply.trim().slice(0, 1800) : "",
      safetyReason: `OpenAI city assistant: ${parsed.reason || "decision returned"}`
    };
  } catch (error) {
    return {
      shouldReply: false,
      text: "",
      safetyReason: `OpenAI chat reply skipped: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function parseCityAssistantJson(text: string): { should_reply: boolean; reason: string; reply: string } {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(clean) as Record<string, unknown>;
  return {
    should_reply: value.should_reply === true,
    reason: typeof value.reason === "string" ? value.reason : "",
    reply: typeof value.reply === "string" ? value.reply : ""
  };
}

async function requestOpenAI(input: {
  apiKey: string;
  instructions: string;
  input: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const data = await requestOpenAIResponses({
      apiKey: input.apiKey,
      payload: {
        model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
        instructions: input.instructions,
        input: input.input,
        max_output_tokens: 180,
        temperature: 0.7
      },
      signal: controller.signal
    });

    const text = extractText(data).trim();

    if (!text) {
      throw new Error("OpenAI returned an empty response");
    }

    return text.slice(0, 900);
  } finally {
    clearTimeout(timeout);
  }
}

function extractText(data: OpenAIResponsesData): string {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter(
      (item) =>
        item.type === "output_text" &&
        typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");
}

/*
 * Эти инструкции применяются к ответу на комментарий.
 * Здесь бот действительно может выступать как администратор.
 */
function buildReplyInstructions(
  channel: MaxEngagementChannelRecord,
  level: number
): string {
  const tone =
    channel.channelKind === "moms"
      ? "доброжелательный, живой стиль родительского сообщества"
      : "живой, аккуратный стиль городского новостного паблика";

  return [
    "Ты отвечаешь на комментарий от имени администратора русскоязычного паблика MAX.",
    `Стиль: ${tone}.`,
    "Ответ должен прямо учитывать смысл поста и комментария.",
    "Не используй универсальные или шаблонные фразы.",
    "Обычно 1–2 предложения, максимум 350 знаков.",
    "Можно задать один естественный встречный вопрос.",
    "Не придумывай факты, адреса, диагнозы, события или личные обстоятельства.",
    "Никогда не шути о смерти, насилии, трагедиях, ЧП, суициде, самоповреждении, болезни или вреде ребёнку.",
    "Не унижай человека и не переходи на личность.",
    level === 0
      ? "Уровень 0: отвечай нейтрально и по существу, без иронии."
      : "",
    level === 1
      ? "Уровень 1: допустима лёгкая дружеская ирония без персонального выпада."
      : "",
    level === 2
      ? "Уровень 2: можно пошутить над ситуацией или темой, но не над человеком."
      : "",
    level === 3
      ? "Уровень 3: можно мягко подколоть формулировку реплики, без оскорблений."
      : "",
    "Не начинай каждый ответ с имени.",
    "Не повторяй текст комментария дословно.",
    "Не используй канцелярит."
  ]
    .filter(Boolean)
    .join("\n");
}

/*
 * Эти инструкции применяются только к инициативному
 * комментарию под публикацией.
 */
function buildInitiativeInstructions(
  channel: MaxEngagementChannelRecord,
  level: number,
  classification: MaxEngagementPostRecord["classification"]
): string {
  const sensitive = isSensitive(classification);

  return [
    "Ты пишешь не от имени администратора.",
    "Ты обычный подписчик городского сообщества, который оставляет один самостоятельный комментарий под публикацией.",
    "",
    "КРИТИЧЕСКИЕ ПРАВИЛА:",
    "Не веди обсуждение и не обращайся ко всей аудитории.",
    "Не используй обращения «девочки», «подписчики», «друзья».",
    "Не пиши «кто сталкивался», «делитесь», «расскажите», «напишите свой опыт», «что думаете».",
    "Не повторяй вопрос, уже заданный автором публикации.",
    "Не пересказывай публикацию другими словами.",
    "Не подписывайся именем администратора.",
    "Не добавляй подпись или роль.",
    "Не выдумывай собственный жизненный опыт.",
    "",
    "ХОРОШИЙ КОММЕНТАРИЙ:",
    "Коротко и естественно реагирует на конкретную ситуацию.",
    "Добавляет одну полезную мысль, осторожную рекомендацию или наблюдение.",
    "При необходимости задаёт один уточняющий вопрос только автору публикации, а не всей группе.",
    "Звучит как обычный человек в комментариях, а не как ведущий паблика.",
    "",
    "Если публикация уже сама полностью запускает обсуждение и новой полезной мысли нет — верни NO_REPLY.",
    "",
    channel.channelKind === "moms"
      ? "Для родительской темы используй спокойный, человечный и поддерживающий тон."
      : "Для городской новости используй естественный и краткий тон местного жителя.",
    sensitive
      ? "Тема чувствительная: полностью исключи юмор, иронию и подкол."
      : level === 0
        ? "Пиши нейтрально, без иронии."
        : level === 1
          ? "Допустима очень лёгкая ирония над ситуацией, но она не обязательна."
          : level === 2
            ? "Можно слегка пошутить над ситуацией, но не над человеком."
            : "Даже при высоком уровне подкола не переходи на личность.",
    "",
    "ДЛЯ МЕДИЦИНСКИХ И ПСИХОЛОГИЧЕСКИХ ТЕМ:",
    "Не ставь диагноз.",
    "Не утверждай причины без оснований.",
    "Не списывай состояние на гормоны, нервы или каприз.",
    "Можно осторожно рекомендовать уточнить ситуацию у врача или специалиста.",
    "Не используй развлекательный тон."
  ]
    .filter(Boolean)
    .join("\n");
}

function fallbackCommentDraft(input: {
  channel: MaxEngagementChannelRecord;
  comment: MaxEngagementCommentRecord;
  decision: MaxEngagementDecision;
  post: MaxEngagementPostRecord | null;
}): MaxEngagementGeneratedDraft {
  const author = input.comment.authorName?.trim();
  const prefix = author ? `${author}, ` : "";
  const level = input.decision.finalTeasingLevel;

  const text =
    level === 0
      ? `${prefix}спасибо, что поделились. А как это выглядит у вас на практике?`
      : level === 1
        ? `${prefix}вот теперь обсуждение стало интереснее 😄 А остальные как думают?`
        : level === 2
          ? `${prefix}ситуация явно решила жить по собственным правилам 😄 У кого было похоже?`
          : `${prefix}звучит уверенно — теперь ждём аргументы второй стороны 😏`;

  return {
    text: appendSignature(text, input.channel),
    safetyReason: "Local fallback reply draft"
  };
}

function cleanInitiativeText(text: string): string {
  const clean = text
    .trim()
    .replace(/^["«]|["»]$/g, "")
    .replace(/\n*[-—]\s*[А-ЯЁA-Z][а-яёa-z]+\s*$/u, "")
    .trim();

  if (!clean || /^NO_REPLY[.!]?$/i.test(clean)) {
    return "";
  }

  return clean;
}

function looksLikeAdminInitiative(text: string): boolean {
  return ADMIN_LIKE_INITIATIVE_PATTERNS.some((pattern) =>
    pattern.test(text)
  );
}

function appendSignature(
  text: string,
  channel: MaxEngagementChannelRecord
): string {
  const clean = text.trim();

  return channel.botSignature
    ? `${clean}\n\n${channel.botSignature}`
    : clean;
}

function isSensitive(
  classification: MaxEngagementPostRecord["classification"]
): boolean {
  return (
    classification === "tragedy" ||
    classification === "emergency" ||
    classification === "death" ||
    classification === "violence" ||
    classification === "child_harm"
  );
}
