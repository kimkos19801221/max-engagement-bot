import type {
  CityMemoryIngestInput,
  CityMemoryKnowledgeKind,
  CityMemoryObjectType,
  CityMemorySourceTrust
} from "./types.js";

export type ExtractedCityKnowledge = {
  objectType: CityMemoryObjectType;
  objectName: string;
  aliases: string[];
  categories: string[];
  relatedTerms: string[];
  kind: CityMemoryKnowledgeKind;
  content: string;
  confidence: number;
  trust: CityMemorySourceTrust;
  validUntil: string | null;
  useRecentObject?: boolean;
};

export type ExtractedCityMemory = {
  findings: ExtractedCityKnowledge[];
  blocked: Array<{ reason: string; textExcerpt: string }>;
};

type CategoryRule = {
  category: string;
  labels: string[];
  patterns: RegExp[];
  relatedTerms: string[];
};

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "детские праздники",
    labels: ["ростовые куклы", "аниматоры", "прокат костюмов"],
    patterns: [/ростов\w*\s+кукл/iu, /аниматор/iu, /прокат\w*\s+костюм/iu, /поздравлен\w*\s+(?:в|для)\s+(?:детск\w*\s+)?сад/iu],
    relatedTerms: ["детские праздники", "ростовая кукла", "ростовые куклы", "аниматор", "аниматоры", "прокат костюмов", "праздничное поздравление", "детский сад"]
  },
  {
    category: "еда и кондитерские изделия",
    labels: ["торты", "пирожные", "кондитеры"],
    patterns: [/торт/iu, /пирожн/iu, /кондитер/iu, /капкейк/iu, /десерт/iu],
    relatedTerms: ["торт", "торты", "пирожные", "кондитер", "кондитерская", "капкейки", "десерты", "заказ еды"]
  },
  {
    category: "медицина",
    labels: ["врачи", "клиники"],
    patterns: [/врач/iu, /доктор/iu, /клиник/iu, /поликлиник/iu, /стоматолог/iu, /педиатр/iu, /гинеколог/iu, /психолог/iu, /логопед/iu],
    relatedTerms: ["врач", "доктор", "клиника", "поликлиника", "медицинский центр", "специалист", "прием"]
  },
  {
    category: "красота и уход",
    labels: ["салоны", "мастера"],
    patterns: [/салон/iu, /парикмах/iu, /маникюр/iu, /визажист/iu, /косметолог/iu, /бровист/iu],
    relatedTerms: ["салон красоты", "мастер", "парикмахер", "маникюр", "визажист", "косметолог", "бровист"]
  },
  {
    category: "образование и дети",
    labels: ["школы", "детские сады", "секции"],
    patterns: [/школ/iu, /детск\w*\s+сад/iu, /садик/iu, /секци/iu, /кружок/iu, /репетитор/iu],
    relatedTerms: ["школа", "детский сад", "садик", "секция", "кружок", "репетитор", "занятия для детей"]
  },
  {
    category: "фото и видео",
    labels: ["фотографы", "видеографы"],
    patterns: [/фотограф/iu, /видеограф/iu, /фотосесси/iu, /видеосъем/iu],
    relatedTerms: ["фотограф", "видеограф", "фотосессия", "фотосъемка", "видеосъемка"]
  },
  {
    category: "ремонт и бытовые услуги",
    labels: ["ремонт", "сервисы", "мастера"],
    patterns: [/ремонт/iu, /сервис/iu, /мастер\w*\s+по/iu, /сантехник/iu, /электрик/iu],
    relatedTerms: ["ремонт", "сервис", "мастер", "бытовые услуги", "сантехник", "электрик"]
  },
  {
    category: "досуг и активный отдых",
    labels: ["верховая езда", "конные прогулки"],
    patterns: [/лошад/iu, /конн/iu, /верхов\w*\s+езд/iu, /ипподром/iu],
    relatedTerms: ["лошади", "конный клуб", "верховая езда", "ипподром", "конные прогулки", "активный отдых"]
  }
];

const SENSITIVE_PATTERNS: Array<[string, RegExp]> = [
  ["personal_phone", /(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/],
  ["private_health_data", /(?:диагноз|болеет|беременна|анализы|вич|онколог|психиатр)/i],
  ["private_family_data", /(?:муж|жена|сын|дочь|ребенок|семья).*(?:адрес|телефон|болеет|диагноз)/i],
  ["accusation_or_rumor", /(?:вор|мошенник|взяточник|наркоман|алкаш|избивает|украл)/i]
];

const ADDRESS_PATTERN = /(?:ул\.?|улица|пр\.?|проспект|пер\.?|переулок|мкр\.?|микрорайон)\s+["«]?[А-ЯA-ZЁа-яa-zё0-9 .-]+["»]?,?\s*\d+[а-яa-z0-9/-]*/giu;
const PARTIAL_ADDRESS_PATTERN = /(?:на|по)\s+(?:улице\s+)?[А-ЯЁ][А-ЯЁа-яё-]{3,}(?:\s+(?:улице|проспекте|переулке))?/gu;
const HOURS_PATTERN = /(?:работает|график|режим работы|открыт[ао]?|принимает)[^.!?\n]{0,90}(?:с\s*)?\d{1,2}[:.]\d{2}\s*(?:до|-|—)\s*\d{1,2}[:.]\d{2}/giu;
const TEMPORARY_PATTERN = /(?:перекрыт|перекрыли|закрыт|закрыли|отключат|отключили|ремонт|авария|до\s+\d{1,2}\s+[а-яё]+)/iu;
const EVENT_PATTERN = /(?:сегодня|завтра|в субботу|в воскресенье|ярмарка|концерт|фестиваль|прием|открытие)/iu;
const CORRECTION_PATTERN = /(?:неверно|исправьте|уже не|переехал[аи]?|закрыл[аи]?|новый адрес|телефон изменился)/iu;
const RECOMMENDATION_PATTERN = /(?:советую|рекомендую|попробуйте|обратитесь|позвоните|ходили|были|понравилось|не понравилось|отзывы|лучше)/iu;
const SERVICE_FACT_PATTERN = /(?:есть|делают|занимаются|изготавливают|сдают|дают|предлагают|работают|можно заказать|можно взять|прокат|аренда)/iu;
const OFFICIAL_PATTERN = /(?:официально|администрация|мэрия|минздрав|мчс|госуслуги|официальный)/iu;
const CONTEXT_PRONOUN_PATTERN = /^(?:у\s+них|там|они|у\s+него|у\s+нее|у\s+неё)/iu;

export function extractCityMemory(input: CityMemoryIngestInput): ExtractedCityMemory {
  const text = compact(input.text);
  const blocked = blockedItems(text);
  if (!text || blocked.length > 0) return { findings: [], blocked };

  const trust = inferTrust(input, text);
  const findings: ExtractedCityKnowledge[] = [];
  const classification = inferClassification(text);
  const object = inferObject(text, classification);

  for (const address of text.matchAll(ADDRESS_PATTERN)) {
    findings.push(createFinding(object, "address", address[0], trust, 0.68));
  }
  for (const address of text.matchAll(PARTIAL_ADDRESS_PATTERN)) {
    findings.push(createFinding(object, "address", `Ориентир: ${address[0]}`, trust, 0.42));
  }
  for (const hours of text.matchAll(HOURS_PATTERN)) {
    findings.push(createFinding(object, "hours", hours[0], trust, 0.62));
  }

  const isRequest = /[?？]/u.test(text) || /(?:подскажите|посоветуйте|порекомендуйте|где можно|кто знает|ищу|нуж(?:ен|на|но|ны))/iu.test(text);
  if (!isRequest && classification.categories.length > 0 && (RECOMMENDATION_PATTERN.test(text) || SERVICE_FACT_PATTERN.test(text))) {
    findings.push({
      ...createFinding(object, "service", normalizeServiceContent(text), trust, RECOMMENDATION_PATTERN.test(text) ? 0.48 : 0.52),
      categories: classification.categories,
      relatedTerms: classification.relatedTerms,
      useRecentObject: object.useRecentObject
    });
  }

  if (TEMPORARY_PATTERN.test(text)) {
    findings.push(createFinding(object, "temporary_change", text, trust, 0.55, inferValidUntil(text)));
  } else if (EVENT_PATTERN.test(text)) {
    findings.push(createFinding(object, "event", text, trust, 0.52, inferValidUntil(text)));
  } else if (CORRECTION_PATTERN.test(text)) {
    findings.push(createFinding(object, "correction", text, trust, 0.58));
  } else if (RECOMMENDATION_PATTERN.test(text)) {
    findings.push(createFinding(object, "resident_recommendation", normalizeOpinion(text), trust, 0.45));
  }

  return { findings: dedupeFindings(findings), blocked };
}

export function expandQueryTerms(query: string): string[] {
  const classification = inferClassification(query);
  return unique([
    ...tokenize(query),
    ...classification.categories.flatMap(tokenize),
    ...classification.relatedTerms.flatMap(tokenize)
  ]);
}

function inferClassification(text: string): { categories: string[]; relatedTerms: string[] } {
  const matched = CATEGORY_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  if (matched.length > 0) {
    return {
      categories: unique(matched.flatMap((rule) => [rule.category, ...rule.labels])),
      relatedTerms: unique(matched.flatMap((rule) => rule.relatedTerms))
    };
  }

  const dynamic = extractRequestedServicePhrase(text);
  return dynamic
    ? { categories: [dynamic], relatedTerms: unique([dynamic, ...tokenize(dynamic)]) }
    : { categories: [], relatedTerms: [] };
}

function extractRequestedServicePhrase(text: string): string | null {
  const patterns = [
    /(?:где\s+(?:можно\s+)?(?:найти|заказать|купить|взять|сделать)|кто\s+(?:делает|занимается)|ищу|нуж(?:ен|на|но|ны))\s+([^?!.]{3,70})/iu,
    /(?:подскажите|посоветуйте|порекомендуйте)\s*,?\s*(?:пожалуйста\s*,?\s*)?(?:где|кто)?\s*([^?!.]{3,70})/iu,
    /(?:занимаются|делают|изготавливают|предлагают|сдают|есть)\s+([^?!.]{3,70})/iu
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern)?.[1];
    if (!match) continue;
    const cleaned = compact(match)
      .replace(/(?:пожалуйста|в нашем городе|в городе|проверенн\w*|с документами|для меня|нам)/giu, "")
      .replace(/^(?:можно|найти|заказать|купить|взять)\s+/iu, "")
      .trim();
    if (cleaned.length >= 3) return cleaned.slice(0, 60).toLowerCase();
  }
  return null;
}

function createFinding(
  object: { type: CityMemoryObjectType; name: string; aliases: string[]; categories: string[]; relatedTerms: string[]; useRecentObject?: boolean },
  kind: CityMemoryKnowledgeKind,
  content: string,
  trust: CityMemorySourceTrust,
  baseConfidence: number,
  validUntil: string | null = null
): ExtractedCityKnowledge {
  return {
    objectType: object.type,
    objectName: object.name,
    aliases: object.aliases,
    categories: object.categories,
    relatedTerms: object.relatedTerms,
    kind,
    content: compact(content),
    confidence: trust === "official" ? Math.max(baseConfidence, 0.9) : baseConfidence,
    trust,
    validUntil,
    useRecentObject: object.useRecentObject
  };
}

function inferObject(
  text: string,
  classification: { categories: string[]; relatedTerms: string[] }
): { type: CityMemoryObjectType; name: string; aliases: string[]; categories: string[]; relatedTerms: string[]; useRecentObject?: boolean } {
  const contextual = CONTEXT_PRONOUN_PATTERN.test(text);
  const quoted = text.match(/[«"]([^»"]{2,80})[»"]/u)?.[1];
  const knownType = text.match(/((?:детская|городская|областная|частная|конный|спортивный|медицинский|семейный)?\s*(?:поликлиника|клиника|сад|школа|клуб|центр|ипподром|секция|студия|мастерская|магазин|аптека|салон|кафе|ресторан|агентство)\s*(?:№\s*\d+|[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z0-9 -]{2,40})?)/iu)?.[1];
  const recommendedName =
    text.match(/(?:попробуйте|обратитесь|позвоните)\s+в\s+[«"]?([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z0-9-]{2,40})[»"]?/iu)?.[1] ??
    text.match(/(?:советую|рекомендую)\s+(?:мастерскую|студию|центр|компанию|салон)?\s*[«"]?([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z0-9-]{2,40})[»"]?/iu)?.[1];
  const name = compact(quoted ?? knownType ?? recommendedName ?? (contextual ? "Контекстная рекомендация" : inferTopicName(text, classification)));
  const lower = name.toLowerCase();
  const organizationLike = Boolean(quoted || knownType || recommendedName);

  return {
    type: organizationLike
      ? (lower.includes("поликлиника") || lower.includes("школа") || lower.includes("сад") ? "institution" : "organization")
      : classification.categories.length > 0 ? "service" : "topic",
    name,
    aliases: aliasVariants(name),
    categories: classification.categories,
    relatedTerms: unique([...classification.relatedTerms, ...tokenize(name)]),
    useRecentObject: contextual
  };
}

function inferTopicName(text: string, classification: { categories: string[] }): string {
  if (classification.categories.length > 0) return classification.categories[0];
  return text.split(/[.!?\n]/u)[0].slice(0, 80) || "Городская тема";
}

function inferTrust(input: CityMemoryIngestInput, text: string): CityMemorySourceTrust {
  if (input.sourceType === "admin" || input.sourceType === "manual") return "admin";
  if (OFFICIAL_PATTERN.test(text)) return "official";
  return "single_resident";
}

function blockedItems(text: string): Array<{ reason: string; textExcerpt: string }> {
  const result: Array<{ reason: string; textExcerpt: string }> = [];
  for (const [reason, pattern] of SENSITIVE_PATTERNS) {
    if (pattern.test(text) && !OFFICIAL_PATTERN.test(text)) result.push({ reason, textExcerpt: text.slice(0, 240) });
  }
  return result;
}

function normalizeServiceContent(text: string): string {
  return `Сообщение жителя об услуге: ${text}`;
}

function normalizeOpinion(text: string): string {
  const negative = /(?:не понравилось|плохо|ужасно|хамят|дорого)/iu.test(text);
  const positive = /(?:понравилось|советую|рекомендую|хорошо|отлично)/iu.test(text);
  if (negative && !positive) return `Житель оставил негативный отзыв: ${text}`;
  if (positive && !negative) return `Житель оставил положительный отзыв: ${text}`;
  return `Житель оставил рекомендацию: ${text}`;
}

function inferValidUntil(text: string): string | null {
  const days = text.match(/до\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/iu);
  if (!days) return null;
  const month = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"].indexOf(days[2].toLowerCase()) + 1;
  const year = new Date().getFullYear();
  return `${year}-${String(month).padStart(2, "0")}-${String(Number(days[1])).padStart(2, "0")}T23:59:59.000Z`;
}

function aliasVariants(name: string): string[] {
  const lower = name.toLowerCase();
  const aliases = [name, lower];
  const number = lower.match(/№\s*(\d+)/u)?.[1];
  if (number && lower.includes("поликлиника")) aliases.push(`поликлиника ${number}`, `${number} поликлиника`, `детская поликлиника ${number}`);
  return unique(aliases.map(compact).filter(Boolean));
}

function dedupeFindings(findings: ExtractedCityKnowledge[]): ExtractedCityKnowledge[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.objectName.toLowerCase()}:${finding.kind}:${finding.content.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function tokenize(value: string): string[] {
  return unique(value.toLowerCase().replace(/ё/gu, "е").match(/[a-zа-я0-9]{3,}/giu) ?? []);
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
