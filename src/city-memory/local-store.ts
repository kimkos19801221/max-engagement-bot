import { randomUUID } from "node:crypto";

import { expandQueryTerms, extractCityMemory, tokenize } from "./extractor.js";
import type {
  CityMemoryCityRecord,
  CityMemoryCandidate,
  CityMemoryIngestInput,
  CityMemoryIngestResult,
  CityMemoryKnowledgeRecord,
  CityMemoryObjectRecord,
  CityMemoryPublicRecord,
  CityMemorySearchResult,
  CityMemorySourceRecord,
  CityMemorySourceTrust,
  CityMemoryState
} from "./types.js";

export function createEmptyCityMemoryState(): CityMemoryState {
  return {
    cities: [],
    publics: [],
    objects: [],
    knowledge: [],
    sources: [],
    revisions: [],
    blockedItems: [],
    conversationSummaries: []
  };
}

export function normalizeCityMemoryState(value: Partial<CityMemoryState> | undefined): CityMemoryState {
  return {
    ...createEmptyCityMemoryState(),
    ...value,
    cities: Array.isArray(value?.cities) ? value.cities : [],
    publics: Array.isArray(value?.publics) ? value.publics : [],
    objects: Array.isArray(value?.objects) ? value.objects : [],
    knowledge: Array.isArray(value?.knowledge) ? value.knowledge : [],
    sources: Array.isArray(value?.sources) ? value.sources : [],
    revisions: Array.isArray(value?.revisions) ? value.revisions : [],
    blockedItems: Array.isArray(value?.blockedItems) ? value.blockedItems : [],
    conversationSummaries: Array.isArray(value?.conversationSummaries) ? value.conversationSummaries : []
  };
}

export function ingestCityMemory(state: CityMemoryState, input: CityMemoryIngestInput): CityMemoryIngestResult {
  const now = new Date().toISOString();
  const result: CityMemoryIngestResult = {
    sources: 0,
    objects: 0,
    knowledge: 0,
    blocked: 0,
    revisions: 0
  };

  const city = upsertCity(state, input.cityName, now);
  const publicRecord = upsertPublic(state, city.id, input.channelId, input.publicTitle, now);
  const extraction = extractCityMemory(input);
  const source = upsertSource(state, city.id, publicRecord.id, input, now);
  result.sources = 1;

  for (const blocked of extraction.blocked) {
    state.blockedItems.push({
      id: randomUUID(),
      cityId: city.id,
      publicId: publicRecord.id,
      sourceId: source.id,
      reason: blocked.reason,
      textExcerpt: blocked.textExcerpt,
      createdAt: now
    });
    result.blocked += 1;
  }

  for (const finding of extraction.findings) {
    const contextualObject = finding.useRecentObject
      ? findRecentContextObject(state, city.id, publicRecord.id, source.receivedAt)
      : null;
    const objectResult = contextualObject
      ? mergeObjectMetadata(contextualObject, finding, now)
      : upsertObject(state, city.id, publicRecord.id, {
          type: finding.objectType,
          name: finding.objectName,
          aliases: finding.aliases,
          categories: finding.categories,
          relatedTerms: finding.relatedTerms,
          confidence: finding.confidence
        }, now);
    if (objectResult.created) result.objects += 1;

    const knowledgeResult = upsertKnowledge(state, city.id, publicRecord.id, objectResult.object.id, {
      kind: finding.kind,
      content: finding.content,
      confidence: finding.confidence,
      trust: finding.trust,
      validUntil: finding.validUntil,
      sourceId: source.id
    }, now);
    if (knowledgeResult.changed) result.knowledge += 1;
    result.revisions += knowledgeResult.revisions;
  }

  return result;
}

export function ingestCityMemoryCandidate(
  state: CityMemoryState,
  input: CityMemoryIngestInput & { candidate: CityMemoryCandidate }
): CityMemoryIngestResult {
  const now = new Date().toISOString();
  const city = upsertCity(state, input.cityName, now);
  const publicRecord = upsertPublic(state, city.id, input.channelId, input.publicTitle, now);
  const source = upsertSource(state, city.id, publicRecord.id, input, now);
  const candidate = input.candidate;

  const objectResult = upsertObject(state, city.id, publicRecord.id, {
    type: candidate.objectType,
    name: candidate.objectName,
    aliases: candidate.aliases,
    categories: candidate.categories,
    relatedTerms: candidate.relatedTerms,
    confidence: candidate.confidence
  }, now);

  const knowledgeResult = upsertKnowledge(state, city.id, publicRecord.id, objectResult.object.id, {
    kind: candidate.knowledgeKind,
    content: candidate.content,
    confidence: candidate.confidence,
    trust: candidate.trust,
    validUntil: candidate.validUntil,
    sourceId: source.id
  }, now);

  return {
    sources: 1,
    objects: objectResult.created ? 1 : 0,
    knowledge: knowledgeResult.changed ? 1 : 0,
    blocked: 0,
    revisions: knowledgeResult.revisions
  };
}

export function searchCityMemory(
  state: CityMemoryState,
  input: { cityName?: string | null; channelId?: string | null; query: string; limit?: number; excludeSourceId?: string }
): CityMemorySearchResult[] {
  const cityIds = new Set(
    state.cities
      .filter((city) => !input.cityName || normalize(city.name) === normalize(input.cityName))
      .map((city) => city.id)
  );
  const publicIds = new Set(
    state.publics
      .filter((item) => (!input.channelId || item.channelId === input.channelId) && (cityIds.size === 0 || cityIds.has(item.cityId)))
      .map((item) => item.id)
  );
  const terms = expandQueryTerms(input.query);
  const excludedInternalSourceIds = new Set(
    state.sources.filter((source) => source.sourceId === input.excludeSourceId).map((source) => source.id)
  );
  const scored = state.objects
    .filter((object) => !object.mergedIntoId)
    .filter((object) => (cityIds.size === 0 || cityIds.has(object.cityId)) && (publicIds.size === 0 || publicIds.has(object.publicId)))
    .map((object) => ({
      object,
      score: scoreObject(object, terms),
      knowledge: state.knowledge.filter((item) =>
        item.objectId === object.id &&
        item.status !== "deleted" &&
        (excludedInternalSourceIds.size === 0 || item.sourceIds.some((sourceId) => !excludedInternalSourceIds.has(sourceId)))
      )
    }))
    .filter((item) => item.score > 0 && item.knowledge.length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 10);

  return scored.map((item) => ({
    object: item.object,
    knowledge: item.knowledge.sort((left, right) => right.confidence - left.confidence),
    score: item.score,
    answerPrefix: answerPrefix(item.knowledge)
  }));
}

export function summarizeCityMemory(state: CityMemoryState) {
  return {
    cities: state.cities.length,
    publics: state.publics.length,
    objects: state.objects.filter((item) => !item.mergedIntoId).length,
    knowledge: state.knowledge.filter((item) => item.status !== "deleted").length,
    needsReview: state.knowledge.filter((item) => item.status === "needs_review").length + state.blockedItems.length,
    blocked: state.blockedItems.length,
    disputed: state.knowledge.filter((item) => item.trust === "disputed" || item.contradictionGroupId).length,
    stale: state.knowledge.filter((item) => isStale(item)).length
  };
}


function findRecentContextObject(
  state: CityMemoryState,
  cityId: string,
  publicId: string,
  receivedAt: string
): CityMemoryObjectRecord | null {
  void receivedAt;
  const candidates = state.knowledge
    .filter((item) => item.cityId === cityId && item.publicId === publicId && item.status !== "deleted")
    .map((item) => ({ item, time: new Date(item.createdAt).getTime() }))
    .sort((left, right) => right.time - left.time);

  for (const candidate of candidates) {
    const object = state.objects.find((item) => item.id === candidate.item.objectId && !item.mergedIntoId);
    if (object && object.type !== "topic" && object.canonicalName !== "Контекстная рекомендация") return object;
  }
  return null;
}

function mergeObjectMetadata(
  object: CityMemoryObjectRecord,
  finding: { categories: string[]; relatedTerms: string[]; confidence: number },
  now: string
): { object: CityMemoryObjectRecord; created: boolean } {
  object.categories = unique([...object.categories, ...finding.categories]);
  object.relatedTerms = unique([...object.relatedTerms, ...finding.relatedTerms]);
  object.confidence = Math.max(object.confidence, finding.confidence);
  object.updatedAt = now;
  return { object, created: false };
}

function upsertCity(state: CityMemoryState, name: string, now: string): CityMemoryCityRecord {
  const normalized = normalize(name || "Неизвестный город");
  const existing = state.cities.find((city) => normalize(city.name) === normalized);
  if (existing) return existing;
  const city = { id: randomUUID(), name: name || "Неизвестный город", createdAt: now };
  state.cities.push(city);
  return city;
}

function upsertPublic(state: CityMemoryState, cityId: string, channelId: string, title: string, now: string): CityMemoryPublicRecord {
  const existing = state.publics.find((item) => item.cityId === cityId && item.channelId === channelId);
  if (existing) {
    existing.title = title || existing.title;
    return existing;
  }
  const item = { id: randomUUID(), cityId, channelId, title: title || channelId, createdAt: now };
  state.publics.push(item);
  return item;
}

function upsertSource(state: CityMemoryState, cityId: string, publicId: string, input: CityMemoryIngestInput, now: string): CityMemorySourceRecord {
  const existing = state.sources.find((item) => item.publicId === publicId && item.sourceType === input.sourceType && item.sourceId === input.sourceId);
  if (existing) return existing;
  const source = {
    id: randomUUID(),
    cityId,
    publicId,
    channelId: input.channelId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    authorName: input.authorName ?? null,
    textExcerpt: input.text.slice(0, 500),
    url: input.url ?? null,
    receivedAt: input.receivedAt ?? now
  };
  state.sources.push(source);
  return source;
}

function upsertObject(
  state: CityMemoryState,
  cityId: string,
  publicId: string,
  input: { type: CityMemoryObjectRecord["type"]; name: string; aliases: string[]; categories: string[]; relatedTerms: string[]; confidence: number },
  now: string
): { object: CityMemoryObjectRecord; created: boolean } {
  const names = new Set([input.name, ...input.aliases].map(normalize));
  const existing = state.objects.find((object) =>
    object.cityId === cityId &&
    object.publicId === publicId &&
    [object.canonicalName, ...object.aliases].some((alias) => names.has(normalize(alias)))
  );

  if (existing) {
    existing.aliases = unique([...existing.aliases, input.name, ...input.aliases]);
    existing.categories = unique([...existing.categories, ...input.categories]);
    existing.relatedTerms = unique([...existing.relatedTerms, ...input.relatedTerms]);
    existing.confidence = Math.max(existing.confidence, input.confidence);
    existing.updatedAt = now;
    return { object: existing, created: false };
  }

  const object = {
    id: randomUUID(),
    cityId,
    publicId,
    type: input.type,
    canonicalName: input.name,
    aliases: unique([input.name, ...input.aliases]),
    categories: unique(input.categories),
    relatedTerms: unique(input.relatedTerms),
    mergedIntoId: null,
    confidence: input.confidence,
    createdAt: now,
    updatedAt: now
  };
  state.objects.push(object);
  return { object, created: true };
}

function upsertKnowledge(
  state: CityMemoryState,
  cityId: string,
  publicId: string,
  objectId: string,
  input: {
    kind: CityMemoryKnowledgeRecord["kind"];
    content: string;
    confidence: number;
    trust: CityMemorySourceTrust;
    validUntil: string | null;
    sourceId: string;
  },
  now: string
): { changed: boolean; revisions: number } {
  const normalizedContent = normalize(input.content);
  const existing = state.knowledge.find((item) =>
    item.objectId === objectId &&
    item.kind === input.kind &&
    item.normalizedContent === normalizedContent
  );

  if (existing) {
    if (!existing.sourceIds.includes(input.sourceId)) {
      existing.sourceIds.push(input.sourceId);
      existing.confirmations += 1;
      existing.confidence = Math.min(0.95, existing.confidence + 0.15);
      existing.trust = upgradeTrust(existing.trust, input.trust, existing.confirmations);
      existing.lastVerifiedAt = now;
      existing.updatedAt = now;
      state.revisions.push({
        id: randomUUID(),
        knowledgeId: existing.id,
        previousContent: existing.content,
        nextContent: existing.content,
        sourceId: input.sourceId,
        changeType: "confirmed",
        createdAt: now
      });
      return { changed: true, revisions: 1 };
    }
    return { changed: false, revisions: 0 };
  }

  const contradictionKinds = new Set<CityMemoryKnowledgeRecord["kind"]>(["address", "hours", "correction", "temporary_change"]);
  const conflict = contradictionKinds.has(input.kind)
    ? state.knowledge.find((item) =>
        item.objectId === objectId &&
        item.kind === input.kind &&
        item.status !== "deleted" &&
        item.normalizedContent !== normalizedContent
      )
    : undefined;
  const contradictionGroupId = conflict ? conflict.contradictionGroupId ?? randomUUID() : null;
  if (conflict && !conflict.contradictionGroupId) {
    conflict.contradictionGroupId = contradictionGroupId;
    conflict.trust = "disputed";
    conflict.status = "needs_review";
  }

  const record: CityMemoryKnowledgeRecord = {
    id: randomUUID(),
    cityId,
    publicId,
    objectId,
    kind: input.kind,
    content: input.content,
    normalizedContent,
    sourceIds: [input.sourceId],
    receivedAt: now,
    lastVerifiedAt: input.trust === "official" || input.trust === "admin" ? now : null,
    validUntil: input.validUntil,
    confidence: contradictionGroupId ? Math.min(input.confidence, 0.45) : input.confidence,
    trust: contradictionGroupId ? "disputed" : input.trust,
    confirmations: 1,
    refutations: 0,
    status: contradictionGroupId ? "needs_review" : input.confidence < 0.5 ? "needs_review" : "active",
    contradictionGroupId,
    createdAt: now,
    updatedAt: now
  };
  state.knowledge.push(record);
  state.revisions.push({
    id: randomUUID(),
    knowledgeId: record.id,
    previousContent: null,
    nextContent: record.content,
    sourceId: input.sourceId,
    changeType: "created",
    createdAt: now
  });
  return { changed: true, revisions: 1 };
}

function scoreObject(object: CityMemoryObjectRecord, terms: string[]): number {
  const haystack = tokenize([
    object.canonicalName,
    ...object.aliases,
    ...object.categories,
    ...object.relatedTerms
  ].join(" "));
  return terms.reduce((sum, term) => {
    const stem = term.length > 5 ? term.slice(0, -2) : term;
    const matched = haystack.some((candidate) =>
      candidate === term || candidate.startsWith(stem) || term.startsWith(candidate.length > 5 ? candidate.slice(0, -2) : candidate)
    );
    return sum + (matched ? 1 : 0);
  }, 0);
}

function answerPrefix(knowledge: CityMemoryKnowledgeRecord[]): string {
  if (knowledge.some((item) => item.trust === "official")) return "Официально подтверждено";
  if (knowledge.some((item) => item.trust === "multi_resident" || item.confirmations > 1)) return "По сообщениям нескольких жителей";
  if (knowledge.some((item) => item.trust === "disputed" || item.contradictionGroupId)) return "Мнения жителей расходятся";
  if (knowledge.some(isStale)) return "Информация могла измениться, лучше уточнить";
  if (knowledge.some((item) => item.trust === "single_resident" || item.status === "needs_review")) return "Один из подписчиков писал";
  return "Насколько я знаю";
}

function upgradeTrust(current: CityMemorySourceTrust, next: CityMemorySourceTrust, confirmations: number): CityMemorySourceTrust {
  if (current === "official" || next === "official") return "official";
  if (current === "admin" || next === "admin") return "admin";
  if (confirmations > 1) return "multi_resident";
  return current;
}

function isStale(item: CityMemoryKnowledgeRecord): boolean {
  if (!item.validUntil) return false;
  return new Date(item.validUntil).getTime() < Date.now();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items.map((item) => typeof item === "string" ? item.trim() : item).filter(Boolean) as T[])];
}
