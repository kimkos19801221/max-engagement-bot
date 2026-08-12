import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

import type {
  MaxApiComment,
  MaxApiPost,
  MaxEngagementChannelRecord,
  MaxEngagementChatMessageRecord,
  MaxEngagementCommentRecord,
  MaxEngagementMode,
  MaxEngagementPostClassification,
  MaxEngagementPostRecord,
  MaxEngagementThreadRecord,
  MaxEngagementThreadStatus,
  MaxUpdate,
  TeasingLevel
} from "./types.js";
import type { ChatPlatform, UnifiedChatMessage } from "../chat-transport/types.js";
import { extractLinkMetadataText } from "./antispam.js";
import { classifyPostText } from "./content-safety.js";
import type { CityMemoryCandidate, CityMemoryIngestResult, CityMemorySearchResult } from "../city-memory/types.js";
import type { ContactDirectoryCandidate, ContactDirectoryRecord, ContactDirectorySearchInput } from "./contact-directory.js";
import { buildContactDirectorySearchTerms, normalizeCategory, normalizePhone, scoreContactDirectoryRecord } from "./contact-directory.js";

type ChannelRow = Record<string, unknown>;
type CommentRow = Record<string, unknown>;
type PostRow = Record<string, unknown>;
type ThreadRow = Record<string, unknown>;
type ChatMessageRow = Record<string, unknown>;

export type BotActionInput = {
  channelId: string;
  postId: string | null;
  chatMessageId?: string | null;
  threadId: string | null;
  triggerCommentId: string | null;
  actionType: "reply" | "initiative" | "moderate" | "stop_thread";
  status: "draft" | "queued" | "skipped" | "posted" | "failed" | "deleted";
  requestedTeasingLevel: TeasingLevel;
  finalTeasingLevel: TeasingLevel;
  safetyReason: string;
  generatedText: string | null;
  requiresHumanReview: boolean;
  postedMaxCommentId?: string | null;
  errorMessage?: string | null;
};

export type EngagementRepository = {
  getMaxPollingMarker(): Promise<number | null>;

  setMaxPollingMarker(marker: number | null): Promise<void>;

  importMaxUpdates(
    updates: MaxUpdate[]
  ): Promise<MaxUpdatesImportResult>;

  importChatMessages(
    messages: UnifiedChatMessage[]
  ): Promise<ChatMessagesImportResult>;

  listRunnableChannels(
    limit?: number
  ): Promise<MaxEngagementChannelRecord[]>;

  listUnprocessedSubscriberComments(
    channelId: string,
    limit?: number
  ): Promise<MaxEngagementCommentRecord[]>;

  /*
   * Новый метод для обычных групповых чатов.
   *
   * В локальном репозитории он будет возвращать реальные сообщения.
   * В удалённом Supabase-репозитории пока возвращается пустой массив,
   * поскольку отдельную таблицу чатов мы ещё не создавали.
   */
  listUnprocessedChatMessages(
    channelId: string,
    limit?: number
  ): Promise<MaxEngagementChatMessageRecord[]>;

  listRecentChatMessages(
    channelId: string,
    beforeIso?: string | null,
    limit?: number
  ): Promise<MaxEngagementChatMessageRecord[]>;

  claimChatMessage(
    messageId: string,
    claimedAt?: string
  ): Promise<boolean>;

  markChatMessageProcessed(
    messageId: string,
    processedAt?: string
  ): Promise<void>;

  searchCityMemory(input: {
    query: string;
    channelId?: string;
    cityName?: string;
    limit?: number;
  }): Promise<CityMemorySearchResult[]>;

  ingestCityMemoryCandidate(input: {
    channel: MaxEngagementChannelRecord;
    sourceId: string;
    authorName?: string | null;
    text: string;
    receivedAt?: string | null;
    candidate: CityMemoryCandidate;
  }): Promise<CityMemoryIngestResult>;

  saveContactDirectoryCandidate(input: {
    channel: MaxEngagementChannelRecord;
    message: MaxEngagementChatMessageRecord;
    candidate: ContactDirectoryCandidate;
  }): Promise<void>;

  searchContactDirectory(input: {
    channel: MaxEngagementChannelRecord;
    query: ContactDirectorySearchInput;
    limit?: number;
  }): Promise<ContactDirectoryRecord[]>;

  listUnprocessedPosts(
    channelId: string,
    limit?: number
  ): Promise<MaxEngagementPostRecord[]>;

  getPost(
    postId: string
  ): Promise<MaxEngagementPostRecord | null>;

  getThread(
    threadId: string | null
  ): Promise<MaxEngagementThreadRecord | null>;

  countActions(
    channelId: string,
    actionType: "reply" | "initiative",
    sinceIso: string
  ): Promise<number>;

  countUserTeasesToday(
    channelId: string,
    authorUserId: string | null,
    sinceIso: string
  ): Promise<number>;

  createBotAction(
    input: BotActionInput
  ): Promise<void>;
};

export type MaxUpdatesImportResult = {
  received: number;
  imported: number;
  channels: number;
  messages: number;
  skipped: number;
};

export type ChatMessagesImportResult = {
  received: number;
  imported: number;
  channels: number;
  messages: number;
  skipped: number;
};

function normalizeMemoryText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/giu, " ").trim();
}

function tokenizeMemoryQuery(value: string): string[] {
  return [...new Set(normalizeMemoryText(value).split(/\s+/u).filter((item) => item.length >= 3))];
}

function scoreMemoryObject(row: Record<string, unknown>, terms: string[]): number {
  const canonical = normalizeMemoryText(String(row.canonical_name ?? ""));
  const aliases = Array.isArray(row.aliases) ? row.aliases.map((item) => normalizeMemoryText(String(item))) : [];
  const categories = Array.isArray(row.categories) ? row.categories.map((item) => normalizeMemoryText(String(item))) : [];
  const related = Array.isArray(row.related_terms) ? row.related_terms.map((item) => normalizeMemoryText(String(item))) : [];
  let score = 0;
  for (const term of terms) {
    if (canonical.includes(term)) score += 6;
    if (aliases.some((item) => item.includes(term))) score += 4;
    if (categories.some((item) => item.includes(term))) score += 3;
    if (related.some((item) => item.includes(term))) score += 2;
  }
  return score;
}

function mapCityMemoryObject(row: Record<string, unknown>) {
  return {
    id: String(row.id), cityId: String(row.city_id), publicId: String(row.public_id),
    type: String(row.object_type) as CityMemoryCandidate["objectType"], canonicalName: String(row.canonical_name),
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
    relatedTerms: Array.isArray(row.related_terms) ? row.related_terms.map(String) : [],
    mergedIntoId: row.merged_into_id ? String(row.merged_into_id) : null, confidence: Number(row.confidence ?? 0),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapCityMemoryKnowledge(row: Record<string, unknown>) {
  return {
    id: String(row.id), cityId: String(row.city_id), publicId: String(row.public_id), objectId: String(row.object_id),
    kind: String(row.knowledge_kind) as CityMemoryCandidate["knowledgeKind"], content: String(row.content),
    normalizedContent: String(row.normalized_content), sourceIds: Array.isArray(row.source_ids) ? row.source_ids.map(String) : [],
    receivedAt: String(row.received_at), lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
    validUntil: row.valid_until ? String(row.valid_until) : null, confidence: Number(row.confidence ?? 0),
    trust: String(row.trust) as CityMemoryCandidate["trust"], confirmations: Number(row.confirmations ?? 1),
    refutations: Number(row.refutations ?? 0), status: String(row.status) as "active" | "needs_review" | "blocked" | "deleted",
    contradictionGroupId: row.contradiction_group_id ? String(row.contradiction_group_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function memoryAnswerPrefix(trusts: string[]): string {
  if (trusts.some((item) => item === "official" || item === "admin")) return "По подтвержденным данным";
  if (trusts.some((item) => item === "multi_resident")) return "По нескольким рекомендациям жителей";
  return "По одной рекомендации участницы";
}

function uniqueMemoryStrings(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value ?? "").trim();
    const key = normalizeMemoryText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function inferRepositoryCityName(channel: MaxEngagementChannelRecord): string {
  const title = channel.title.trim();
  const match = title.match(/(?:мамочки|мамы|город|чат)\s+([А-ЯЁA-Z][А-Яа-яЁёA-Za-z-]+)/u);
  return match?.[1] ?? (title.replace(/[💕❤❤️]/gu, "").trim() || "Неизвестный город");
}

export function createSupabaseClientFromEnv(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SECRET_KEY are required for the engagement worker"
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false
    },
    realtime: {
      transport: WebSocket as never
    }
  });
}

export class MaxEngagementRepository implements EngagementRepository {
  constructor(
    private readonly supabase: SupabaseClient
  ) {}

  async importMaxUpdates(
    updates: MaxUpdate[]
  ): Promise<MaxUpdatesImportResult> {
    const result: MaxUpdatesImportResult = {
      received: updates.length,
      imported: 0,
      channels: 0,
      messages: 0,
      skipped: 0
    };

    for (const update of updates) {
      const channel = await this.upsertChannelFromUpdate(update);

      if (channel.created) {
        result.channels += 1;
      }

      if (
        update.update_type === "message_created" &&
        update.message &&
        channel.record
      ) {
        const imported = await this.importMessageCreatedUpdate(
          channel.record,
          update
        );

        if (imported) {
          result.messages += 1;
        } else {
          result.skipped += 1;
        }
      }

      result.imported += 1;
    }

    return result;
  }

  async importChatMessages(
    messages: UnifiedChatMessage[]
  ): Promise<ChatMessagesImportResult> {
    const result: ChatMessagesImportResult = {
      received: messages.length,
      imported: 0,
      channels: 0,
      messages: 0,
      skipped: 0
    };

    for (const message of messages) {
      const channel = await this.upsertChannelFromUnifiedChatMessage(message);
      if (channel.created) result.channels += 1;
      if (!channel.record) {
        result.skipped += 1;
        continue;
      }

      const imported = await this.importUnifiedChatMessage(channel.record, message);
      if (imported) result.messages += 1;
      else result.skipped += 1;
      result.imported += 1;
    }

    return result;
  }

  async listRunnableChannels(
    limit = 25
  ): Promise<MaxEngagementChannelRecord[]> {
    const { data, error } = await this.supabase
      .from("max_engagement_channels")
      .select("*")
      .eq("enabled", true)
      .neq("mode", "off")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return (data ?? []).map(mapChannel);
  }

  async getMaxPollingMarker(): Promise<number | null> {
    const { data, error } = await this.supabase
      .from("max_engagement_runtime_state")
      .select("value")
      .eq("key", "max_polling_marker")
      .maybeSingle();

    if (error) {
      throw error;
    }

    const value = data?.value;
    if (!value || typeof value !== "object") {
      return null;
    }

    const marker = (value as Record<string, unknown>).marker;
    return typeof marker === "number" && Number.isFinite(marker)
      ? marker
      : null;
  }

  async setMaxPollingMarker(marker: number | null): Promise<void> {
    const { error } = await this.supabase
      .from("max_engagement_runtime_state")
      .upsert(
        {
          key: "max_polling_marker",
          value: { marker },
          updated_at: new Date().toISOString()
        },
        { onConflict: "key" }
      );

    if (error) {
      throw error;
    }
  }

  async listUnprocessedChatMessages(
    channelId: string,
    limit = 50
  ): Promise<MaxEngagementChatMessageRecord[]> {
    const { data, error } = await this.supabase
      .from("max_engagement_chat_messages")
      .select("*")
      .eq("channel_id", channelId)
      .is("processed_at", null)
      .order("posted_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => mapChatMessage(row as ChatMessageRow));
  }

  async listRecentChatMessages(
    channelId: string,
    beforeIso: string | null = null,
    limit = 20
  ): Promise<MaxEngagementChatMessageRecord[]> {
    let query = this.supabase
      .from("max_engagement_chat_messages")
      .select("*")
      .eq("channel_id", channelId);

    if (beforeIso) {
      query = query.lt("posted_at", beforeIso);
    }

    const { data, error } = await query
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return (data ?? [])
      .map((row) => mapChatMessage(row as ChatMessageRow))
      .reverse();
  }

  async claimChatMessage(
    messageId: string,
    claimedAt = new Date().toISOString()
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("max_engagement_chat_messages")
      .update({ processed_at: claimedAt })
      .eq("id", messageId)
      .is("processed_at", null)
      .select("id");

    if (error) {
      throw error;
    }

    return (data ?? []).length === 1;
  }

  async markChatMessageProcessed(
    messageId: string,
    processedAt = new Date().toISOString()
  ): Promise<void> {
    const { error } = await this.supabase
      .from("max_engagement_chat_messages")
      .update({ processed_at: processedAt })
      .eq("id", messageId);

    if (error) {
      throw error;
    }
  }

  async searchCityMemory(input: {
    query: string;
    channelId?: string;
    cityName?: string;
    limit?: number;
  }): Promise<CityMemorySearchResult[]> {
    let publicQuery = this.supabase
      .from("city_memory_publics")
      .select("id, city_id, channel_id, title, created_at");

    if (input.channelId) {
      publicQuery = publicQuery.eq("channel_id", input.channelId);
    }

    const { data: publics, error: publicsError } = await publicQuery;
    if (publicsError) throw publicsError;
    const publicRows = publics ?? [];
    if (publicRows.length === 0) return [];

    let allowedPublics = publicRows;
    if (input.cityName) {
      const cityIds = [...new Set(publicRows.map((row) => String(row.city_id)))];
      const { data: cities, error: citiesError } = await this.supabase
        .from("city_memory_cities")
        .select("id, name")
        .in("id", cityIds);
      if (citiesError) throw citiesError;
      const wanted = normalizeMemoryText(input.cityName);
      const allowedCityIds = new Set((cities ?? []).filter((row) => normalizeMemoryText(String(row.name)) === wanted).map((row) => String(row.id)));
      allowedPublics = publicRows.filter((row) => allowedCityIds.has(String(row.city_id)));
    }

    const publicIds = allowedPublics.map((row) => String(row.id));
    if (publicIds.length === 0) return [];

    const { data: objects, error: objectsError } = await this.supabase
      .from("city_memory_objects")
      .select("id, city_id, public_id, object_type, canonical_name, aliases, categories, related_terms, merged_into_id, confidence, created_at, updated_at")
      .in("public_id", publicIds)
      .is("merged_into_id", null)
      .limit(300);
    if (objectsError) throw objectsError;
    const objectRows = objects ?? [];
    if (objectRows.length === 0) return [];

    const terms = tokenizeMemoryQuery(input.query);
    const scored = objectRows
      .map((row) => ({ row, score: scoreMemoryObject(row as Record<string, unknown>, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(input.limit ?? 6, 1));
    if (scored.length === 0) return [];

    const objectIds = scored.map((item) => String(item.row.id));
    const { data: knowledge, error: knowledgeError } = await this.supabase
      .from("city_memory_knowledge")
      .select("id, city_id, public_id, object_id, knowledge_kind, content, normalized_content, source_ids, received_at, last_verified_at, valid_until, confidence, trust, confirmations, refutations, status, contradiction_group_id, created_at, updated_at")
      .in("object_id", objectIds)
      .neq("status", "deleted")
      .order("confidence", { ascending: false });
    if (knowledgeError) throw knowledgeError;

    return scored.map(({ row, score }) => {
      const itemKnowledge = (knowledge ?? []).filter((item) => String(item.object_id) === String(row.id));
      return {
        object: mapCityMemoryObject(row as Record<string, unknown>),
        knowledge: itemKnowledge.map((item) => mapCityMemoryKnowledge(item as Record<string, unknown>)),
        score,
        answerPrefix: memoryAnswerPrefix(itemKnowledge.map((item) => String(item.trust)))
      };
    }).filter((item) => item.knowledge.length > 0);
  }

  async ingestCityMemoryCandidate(input: {
    channel: MaxEngagementChannelRecord;
    sourceId: string;
    authorName?: string | null;
    text: string;
    receivedAt?: string | null;
    candidate: CityMemoryCandidate;
  }): Promise<CityMemoryIngestResult> {
    const cityName = inferRepositoryCityName(input.channel);
    const { data: city, error: cityError } = await this.supabase
      .from("city_memory_cities")
      .upsert({ name: cityName }, { onConflict: "name" })
      .select("id")
      .single();
    if (cityError) throw cityError;

    const { data: publicRow, error: publicError } = await this.supabase
      .from("city_memory_publics")
      .upsert({ city_id: city.id, channel_id: input.channel.id, title: input.channel.title }, { onConflict: "city_id,channel_id" })
      .select("id")
      .single();
    if (publicError) throw publicError;

    const { data: source, error: sourceError } = await this.supabase
      .from("city_memory_sources")
      .upsert({
        city_id: city.id,
        public_id: publicRow.id,
        channel_id: input.channel.id,
        source_type: "comment",
        source_id: input.sourceId,
        author_name: input.authorName ?? null,
        text_excerpt: input.text.slice(0, 500),
        received_at: input.receivedAt ?? new Date().toISOString()
      }, { onConflict: "public_id,source_type,source_id" })
      .select("id")
      .single();
    if (sourceError) throw sourceError;

    const canonical = input.candidate.objectName.trim();
    const { data: existingObjects, error: existingError } = await this.supabase
      .from("city_memory_objects")
      .select("id, aliases, categories, related_terms, confidence")
      .eq("public_id", publicRow.id)
      .ilike("canonical_name", canonical)
      .limit(1);
    if (existingError) throw existingError;

    let objectId: string;
    let objectCreated = 0;
    const existing = existingObjects?.[0];
    if (existing) {
      objectId = String(existing.id);
      const { error: updateError } = await this.supabase
        .from("city_memory_objects")
        .update({
          aliases: uniqueMemoryStrings([...(existing.aliases ?? []), canonical, ...input.candidate.aliases]),
          categories: uniqueMemoryStrings([...(existing.categories ?? []), ...input.candidate.categories]),
          related_terms: uniqueMemoryStrings([...(existing.related_terms ?? []), ...input.candidate.relatedTerms]),
          confidence: Math.max(Number(existing.confidence ?? 0), input.candidate.confidence),
          updated_at: new Date().toISOString()
        })
        .eq("id", objectId);
      if (updateError) throw updateError;
    } else {
      const { data: objectRow, error: objectError } = await this.supabase
        .from("city_memory_objects")
        .insert({
          city_id: city.id,
          public_id: publicRow.id,
          object_type: input.candidate.objectType,
          canonical_name: canonical,
          aliases: uniqueMemoryStrings([canonical, ...input.candidate.aliases]),
          categories: uniqueMemoryStrings(input.candidate.categories),
          related_terms: uniqueMemoryStrings(input.candidate.relatedTerms),
          confidence: input.candidate.confidence
        })
        .select("id")
        .single();
      if (objectError) throw objectError;
      objectId = String(objectRow.id);
      objectCreated = 1;
    }

    const normalizedContent = normalizeMemoryText(input.candidate.content);
    const { data: existingKnowledge, error: knowledgeLookupError } = await this.supabase
      .from("city_memory_knowledge")
      .select("id, source_ids, confirmations, confidence, trust")
      .eq("object_id", objectId)
      .eq("knowledge_kind", input.candidate.knowledgeKind)
      .eq("normalized_content", normalizedContent)
      .limit(1);
    if (knowledgeLookupError) throw knowledgeLookupError;

    let knowledgeChanged = 0;
    const known = existingKnowledge?.[0];
    if (known) {
      const sourceIds = uniqueMemoryStrings([...(known.source_ids ?? []), String(source.id)]);
      if (sourceIds.length > (known.source_ids ?? []).length) {
        const confirmations = Number(known.confirmations ?? 1) + 1;
        const { error: updateKnowledgeError } = await this.supabase
          .from("city_memory_knowledge")
          .update({
            source_ids: sourceIds,
            confirmations,
            confidence: Math.min(0.95, Number(known.confidence ?? 0.4) + 0.15),
            trust: confirmations >= 2 ? "multi_resident" : known.trust,
            updated_at: new Date().toISOString()
          })
          .eq("id", known.id);
        if (updateKnowledgeError) throw updateKnowledgeError;
        knowledgeChanged = 1;
      }
    } else {
      const { error: insertKnowledgeError } = await this.supabase
        .from("city_memory_knowledge")
        .insert({
          city_id: city.id,
          public_id: publicRow.id,
          object_id: objectId,
          knowledge_kind: input.candidate.knowledgeKind,
          content: input.candidate.content,
          normalized_content: normalizedContent,
          source_ids: [source.id],
          valid_until: input.candidate.validUntil,
          confidence: input.candidate.confidence,
          trust: input.candidate.trust,
          confirmations: 1,
          status: input.candidate.trust === "single_resident" ? "needs_review" : "active"
        });
      if (insertKnowledgeError) throw insertKnowledgeError;
      knowledgeChanged = 1;
    }

    return { sources: 1, objects: objectCreated, knowledge: knowledgeChanged, blocked: 0, revisions: 0 };
  }

  async saveContactDirectoryCandidate(input: {
    channel: MaxEngagementChannelRecord;
    message: MaxEngagementChatMessageRecord;
    candidate: ContactDirectoryCandidate;
  }): Promise<void> {
    const cityName = inferRepositoryCityName(input.channel);
    const { data: city, error: cityError } = await this.supabase
      .from("city_memory_cities")
      .upsert({ name: cityName }, { onConflict: "name" })
      .select("id")
      .single();
    if (cityError) throw cityError;

    const { data: publicRow, error: publicError } = await this.supabase
      .from("city_memory_publics")
      .upsert({
        city_id: city.id,
        channel_id: input.channel.id,
        title: input.channel.title
      }, { onConflict: "city_id,channel_id" })
      .select("id")
      .single();
    if (publicError) throw publicError;

    const normalizedPhone = normalizePhone(input.candidate.phone);
    const normalizedCategory = normalizeCategory(input.candidate.category);
    const now = input.message.postedAt ?? new Date().toISOString();

    let existingQuery = this.supabase
      .from("city_contact_directory")
      .select("id, times_shared");

    if (input.candidate.maxContactId) {
      existingQuery = existingQuery
        .eq("channel_id", input.channel.id)
        .eq("max_contact_id", input.candidate.maxContactId);
    } else if (normalizedPhone) {
      existingQuery = existingQuery
        .eq("channel_id", input.channel.id)
        .eq("normalized_phone", normalizedPhone);
    } else {
      existingQuery = existingQuery
        .eq("channel_id", input.channel.id)
        .eq("attachment_fingerprint", input.candidate.attachmentFingerprint);
    }

    const { data: existingRows, error: lookupError } = await existingQuery.limit(1);
    if (lookupError) throw lookupError;
    const existing = existingRows?.[0];

    if (existing) {
      const { error } = await this.supabase
        .from("city_contact_directory")
        .update({
          category: input.candidate.category,
          normalized_category: normalizedCategory,
          contact_name: input.candidate.contactName,
          phone: input.candidate.phone,
          normalized_phone: normalizedPhone,
          max_contact_id: input.candidate.maxContactId,
          raw_attachment: input.candidate.rawAttachment,
          source_message_id: input.message.maxMessageId,
          source_author_name: input.message.authorName,
          source_context: input.candidate.sourceContext,
          last_seen_at: now,
          times_shared: Number(existing.times_shared ?? 1) + 1,
          updated_at: new Date().toISOString()
        })
        .eq("id", existing.id);
      if (error) throw error;
      return;
    }

    const { error } = await this.supabase
      .from("city_contact_directory")
      .insert({
        city_id: city.id,
        public_id: publicRow.id,
        channel_id: input.channel.id,
        category: input.candidate.category,
        normalized_category: normalizedCategory,
        contact_name: input.candidate.contactName,
        phone: input.candidate.phone,
        normalized_phone: normalizedPhone,
        max_contact_id: input.candidate.maxContactId,
        attachment_fingerprint: input.candidate.attachmentFingerprint,
        raw_attachment: input.candidate.rawAttachment,
        source_message_id: input.message.maxMessageId,
        source_author_name: input.message.authorName,
        source_context: input.candidate.sourceContext,
        first_seen_at: now,
        last_seen_at: now,
        times_shared: 1
      });
    if (error) throw error;
  }

  async searchContactDirectory(input: {
    channel: MaxEngagementChannelRecord;
    query: ContactDirectorySearchInput;
    limit?: number;
  }): Promise<ContactDirectoryRecord[]> {
    const terms = buildContactDirectorySearchTerms(input.query);
    if (terms.length === 0) return [];

    const { data: publicRow, error: publicError } = await this.supabase
      .from("city_memory_publics")
      .select("city_id")
      .eq("channel_id", input.channel.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (publicError) throw publicError;
    const cityId = typeof publicRow?.city_id === "string" ? publicRow.city_id : null;
    if (!cityId) return [];

    const { data, error } = await this.supabase
      .from("city_contact_directory")
      .select("id, city_id, channel_id, category, normalized_category, contact_name, phone, normalized_phone, max_contact_id, raw_attachment, source_message_id, source_author_name, source_context, first_seen_at, last_seen_at, times_shared")
      .eq("city_id", cityId)
      .order("times_shared", { ascending: false })
      .order("last_seen_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    return (data ?? [])
      .map((row) => mapContactDirectoryRecord(row as Record<string, unknown>))
      .map((record) => ({ record, score: scoreContactDirectoryRecord(record, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || compareIsoDesc(left.record.lastSeenAt, right.record.lastSeenAt))
      .slice(0, Math.max(1, input.limit ?? 3))
      .map((item) => item.record);
  }

  async listUnprocessedSubscriberComments(
    channelId: string,
    limit = 50
  ): Promise<MaxEngagementCommentRecord[]> {
    const fetchLimit = Math.max(limit * 10, 500);

    const { data, error } = await this.supabase
      .from("max_engagement_comments")
      .select(
        "id, channel_id, post_id, thread_id, max_comment_id, author_user_id, author_name, text, posted_at, collected_at"
      )
      .eq("channel_id", channelId)
      .eq("comment_kind", "subscriber")
      .order("collected_at", { ascending: false })
      .limit(fetchLimit);

    if (error) {
      throw error;
    }

    const rawRows = data ?? [];

    if (rawRows.length === 0) {
      return [];
    }

    const rows = rawRows.map(mapComment);
    const processed = await this.listProcessedTriggerIds(
      rows.map((row) => row.id)
    );

    return rawRows
      .filter((row) => !processed.has(String(row.id)))
      .sort((left, right) =>
        String(left.collected_at ?? "").localeCompare(
          String(right.collected_at ?? "")
        )
      )
      .slice(0, limit)
      .map(mapComment);
  }

  async listUnprocessedPosts(
    channelId: string,
    limit = 20
  ): Promise<MaxEngagementPostRecord[]> {
    const fetchLimit = Math.max(limit * 10, 500);

    const { data, error } = await this.supabase
      .from("max_engagement_posts")
      .select(
        "id, channel_id, max_post_id, text, classification, classification_confidence, posted_at, collected_at"
      )
      .eq("channel_id", channelId)
      .order("collected_at", { ascending: false })
      .limit(fetchLimit);

    if (error) {
      throw error;
    }

    const rawRows = data ?? [];

    if (rawRows.length === 0) {
      return [];
    }

    const rows = rawRows.map(mapPost);
    const processed = await this.listInitiativePostIds(
      rows.map((row) => row.id)
    );

    return rawRows
      .filter((row) => !processed.has(String(row.id)))
      .sort((left, right) =>
        String(left.collected_at ?? "").localeCompare(
          String(right.collected_at ?? "")
        )
      )
      .slice(0, limit)
      .map(mapPost);
  }

  async getPost(
    postId: string
  ): Promise<MaxEngagementPostRecord | null> {
    if (!postId) {
      return null;
    }

    const { data, error } = await this.supabase
      .from("max_engagement_posts")
      .select(
        "id, channel_id, max_post_id, text, classification, classification_confidence, posted_at"
      )
      .eq("id", postId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? mapPost(data as PostRow)
      : null;
  }

  async getThread(
    threadId: string | null
  ): Promise<MaxEngagementThreadRecord | null> {
    if (!threadId) {
      return null;
    }

    const { data, error } = await this.supabase
      .from("max_engagement_threads")
      .select(
        "id, channel_id, post_id, max_thread_id, status"
      )
      .eq("id", threadId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data
      ? mapThread(data as ThreadRow)
      : null;
  }

  async countActions(
    channelId: string,
    actionType: "reply" | "initiative",
    sinceIso: string
  ): Promise<number> {
    const { count, error } = await this.supabase
      .from("max_engagement_bot_actions")
      .select("id", {
        count: "exact",
        head: true
      })
      .eq("channel_id", channelId)
      .eq("action_type", actionType)
      .gte("created_at", sinceIso);

    if (error) {
      throw error;
    }

    return count ?? 0;
  }

  async countUserTeasesToday(
    channelId: string,
    authorUserId: string | null,
    sinceIso: string
  ): Promise<number> {
    if (!authorUserId) {
      return 0;
    }

    const { data: comments, error: commentsError } =
      await this.supabase
        .from("max_engagement_comments")
        .select("id")
        .eq("channel_id", channelId)
        .eq("author_user_id", authorUserId)
        .gte("collected_at", sinceIso);

    if (commentsError) {
      throw commentsError;
    }

    const triggerIds = (comments ?? []).map(
      (row: { id: string }) => row.id
    );

    if (triggerIds.length === 0) {
      return 0;
    }

    const { count, error } = await this.supabase
      .from("max_engagement_bot_actions")
      .select("id", {
        count: "exact",
        head: true
      })
      .eq("channel_id", channelId)
      .in("trigger_comment_id", triggerIds)
      .gt("final_teasing_level", 0)
      .gte("created_at", sinceIso);

    if (error) {
      throw error;
    }

    return count ?? 0;
  }

  async createBotAction(
    input: BotActionInput
  ): Promise<void> {
    const { error } = await this.supabase
      .from("max_engagement_bot_actions")
      .insert({
        channel_id: input.channelId,
        post_id: input.postId ?? null,
        chat_message_id: input.chatMessageId ?? null,
        thread_id: input.threadId,
        trigger_comment_id: input.triggerCommentId,
        action_type: input.actionType,
        status: input.status,
        requested_teasing_level: input.requestedTeasingLevel,
        final_teasing_level: input.finalTeasingLevel,
        safety_reason: input.safetyReason,
        generated_text: input.generatedText,
        requires_human_review: input.requiresHumanReview,
        posted_max_comment_id:
          input.postedMaxCommentId ?? null,
        posted_at:
          input.status === "posted"
            ? new Date().toISOString()
            : null,
        error_message: input.errorMessage ?? null
      });

    if (error) {
      throw error;
    }
  }

  async upsertMaxPost(
    channel: MaxEngagementChannelRecord,
    post: MaxApiPost
  ): Promise<MaxEngagementPostRecord> {
    const classification = classifyPostText(post.text);

    const { data, error } = await this.supabase
      .from("max_engagement_posts")
      .upsert(
        {
          channel_id: channel.id,
          max_post_id: post.id,
          source_url: post.url ?? null,
          author_name: post.authorName ?? null,
          text: post.text,
          posted_at: post.postedAt ?? null,
          classification: classification.classification,
          classification_confidence: classification.confidence,
          classification_reason: classification.reason,
          forced_teasing_level:
            classification.classification === "neutral" ||
            classification.classification === "entertainment"
              ? channel.teasingLevel
              : 0,
          comments_before: post.commentsCount ?? null,
          reactions_before: post.reactionsCount ?? null
        },
        {
          onConflict: "channel_id,max_post_id"
        }
      )
      .select(
        "id, channel_id, max_post_id, text, classification, classification_confidence, posted_at"
      )
      .single();

    if (error) {
      throw error;
    }

    return mapPost(data as PostRow);
  }

  async upsertMaxThread(
    channelId: string,
    postId: string,
    maxThreadId: string
  ): Promise<MaxEngagementThreadRecord> {
    const { data, error } = await this.supabase
      .from("max_engagement_threads")
      .upsert(
        {
          channel_id: channelId,
          post_id: postId,
          max_thread_id: maxThreadId,
          status: "active"
        },
        {
          onConflict: "post_id,max_thread_id"
        }
      )
      .select(
        "id, channel_id, post_id, max_thread_id, status"
      )
      .single();

    if (error) {
      throw error;
    }

    return mapThread(data as ThreadRow);
  }

  async upsertMaxComment(
    channelId: string,
    postId: string,
    threadId: string,
    comment: MaxApiComment
  ): Promise<MaxEngagementCommentRecord> {
    const { data: existing, error: existingError } =
      await this.supabase
        .from("max_engagement_comments")
        .select("id")
        .eq("channel_id", channelId)
        .eq("max_comment_id", comment.id)
        .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      const { data, error } = await this.supabase
        .from("max_engagement_comments")
        .update({
          post_id: postId,
          thread_id: threadId,
          parent_max_comment_id:
            comment.parentCommentId ?? null,
          author_user_id:
            comment.authorUserId ?? null,
          author_name:
            comment.authorName ?? null,
          text: comment.text,
          posted_at:
            comment.postedAt ?? null
        })
        .eq("id", existing.id)
        .select(
          "id, channel_id, post_id, thread_id, max_comment_id, author_user_id, author_name, text, posted_at"
        )
        .single();

      if (error) {
        throw error;
      }

      return mapComment(data as CommentRow);
    }

    const { data, error } = await this.supabase
      .from("max_engagement_comments")
      .insert({
        channel_id: channelId,
        post_id: postId,
        thread_id: threadId,
        max_comment_id: comment.id,
        parent_max_comment_id:
          comment.parentCommentId ?? null,
        author_user_id:
          comment.authorUserId ?? null,
        author_name:
          comment.authorName ?? null,
        text: comment.text,
        comment_kind: "subscriber",
        sentiment: "unknown",
        posted_at:
          comment.postedAt ?? null
      })
      .select(
        "id, channel_id, post_id, thread_id, max_comment_id, author_user_id, author_name, text, posted_at"
      )
      .single();

    if (error) {
      throw error;
    }

    return mapComment(data as CommentRow);
  }

  private async upsertChannelFromUnifiedChatMessage(
    message: UnifiedChatMessage
  ): Promise<{ record: MaxEngagementChannelRecord | null; created: boolean }> {
    const externalChatId = message.externalChatId.trim();
    if (!externalChatId) return { record: null, created: false };

    const { data: existing, error: existingError } = await this.supabase
      .from("max_engagement_channels")
      .select("*")
      .eq("platform", message.platform)
      .eq("max_channel_id", externalChatId)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existing) {
      const mapped = mapChannel(existing as ChannelRow);
      const patch: Record<string, unknown> = {};
      const isMaxChat = message.platform === "max";
      if ((mapped.communityType ?? "channel") !== "chat") patch.community_type = "chat";
      if (!mapped.enabled) patch.enabled = true;
      if (mapped.mode === "off") patch.mode = "suitable_messages";
      if (mapped.dryRun) patch.dry_run = false;
      if (isMaxChat && (existing as ChannelRow).antispam_enabled !== true) patch.antispam_enabled = true;
      if (isMaxChat && (existing as ChannelRow).antispam_delete_links !== true) patch.antispam_delete_links = true;
      if (message.chatTitle?.trim() && mapped.title !== message.chatTitle.trim()) patch.title = message.chatTitle.trim();

      if (Object.keys(patch).length > 0) {
        const { data: updated, error: updateError } = await this.supabase
          .from("max_engagement_channels")
          .update(patch)
          .eq("id", mapped.id)
          .select("*")
          .single();
        if (updateError) throw updateError;
        return { record: mapChannel(updated as ChannelRow), created: false };
      }
      return { record: mapped, created: false };
    }

    const platformLabel = message.platform === "telegram" ? "Telegram" : "MAX";
    const row = {
      platform: message.platform,
      max_channel_id: externalChatId,
      title: message.chatTitle?.trim() || `${platformLabel} чат ${externalChatId}`,
      community_type: "chat",
      channel_kind: "moms",
      enabled: true,
      mode: "suitable_messages",
      antispam_enabled: message.platform === "max",
      antispam_delete_links: true,
      teasing_level: 1,
      politics_teasing_level: 0,
      bot_name: "Алина",
      bot_signature: "- Алина",
      dry_run: false
    };

    const { data, error } = await this.supabase
      .from("max_engagement_channels")
      .insert(row)
      .select("*")
      .single();
    if (error) throw error;
    return { record: mapChannel(data as ChannelRow), created: true };
  }

  private async importUnifiedChatMessage(
    channel: MaxEngagementChannelRecord,
    message: UnifiedChatMessage
  ): Promise<boolean> {
    const text = message.text.trim();
    if (!message.externalMessageId || (!text && message.attachments.length === 0)) return false;

    const row = {
      channel_id: channel.id,
      max_message_id: message.externalMessageId,
      author_user_id: message.authorId,
      author_name: message.authorName,
      author_is_bot: message.authorIsBot,
      text,
      attachments: message.attachments.map((attachment) => ({
        kind: attachment.kind,
        raw: attachment.raw
      })),
      posted_at: message.postedAt,
      linked_text: [message.linkedText, message.metadataText].filter((value): value is string => Boolean(value)).join("\n") || null,
      reply_to_max_message_id: message.replyToMessageId
    };

    const { error } = await this.supabase
      .from("max_engagement_chat_messages")
      .upsert(row, { onConflict: "channel_id,max_message_id", ignoreDuplicates: true });
    if (error) throw error;
    return true;
  }

  private async upsertChannelFromUpdate(
    update: MaxUpdate
  ): Promise<{
    record: MaxEngagementChannelRecord | null;
    created: boolean;
  }> {
    const chatId =
      update.chat_id ??
      update.message?.recipient?.chat_id;

    if (
      chatId === undefined ||
      chatId === null
    ) {
      return {
        record: null,
        created: false
      };
    }

    const maxChannelId = String(chatId);

    const communityType =
      update.message?.recipient?.chat_type === "chat"
        ? "chat"
        : "channel";

    const { data: existing, error: existingError } =
      await this.supabase
        .from("max_engagement_channels")
        .select("*")
        .eq("platform", "max")
        .eq("max_channel_id", maxChannelId)
        .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      const mapped = mapChannel(existing as ChannelRow);
      const needsMaxChatAntispam =
        communityType === "chat" &&
        ((existing as ChannelRow).antispam_enabled !== true ||
          (existing as ChannelRow).antispam_delete_links !== true);
      if (communityType === "chat" && (
        mapped.communityType !== "chat" ||
        !mapped.enabled ||
        mapped.mode === "off" ||
        mapped.dryRun ||
        needsMaxChatAntispam
      )) {
        const patch = {
          community_type: "chat",
          title: mapped.title.startsWith("MAX канал ")
            ? `MAX чат ${maxChannelId}`
            : mapped.title,
          channel_kind: "moms",
          enabled: true,
          mode: "suitable_messages",
          antispam_enabled: true,
          antispam_delete_links: true,
          dry_run: false
        };

        const { data: updated, error: updateError } = await this.supabase
          .from("max_engagement_channels")
          .update(patch)
          .eq("id", mapped.id)
          .select("*")
          .single();

        if (updateError) {
          throw updateError;
        }

        return {
          record: mapChannel(updated as ChannelRow),
          created: false
        };
      }

      return {
        record: {
          ...mapped,
          communityType
        },
        created: false
      };
    }

    const isChat = communityType === "chat";

    /*
     * Не добавляем community_type в insert:
     * такого столбца в текущей базе может ещё не быть.
     */
    const row = {
      platform: "max",
      max_channel_id: maxChannelId,
      title:
        isChat
          ? `MAX чат ${maxChannelId}`
          : `MAX канал ${maxChannelId}`,
      channel_kind: isChat ? "moms" : "news",
      enabled: isChat,
      mode: isChat ? "suitable_messages" : "off",
      antispam_enabled: isChat,
      antispam_delete_links: true,
      teasing_level: 1,
      politics_teasing_level: 0,
      bot_name: "Алина",
      bot_signature: "- Алина",
      dry_run: !isChat
    };

    let insertResult = await this.supabase
      .from("max_engagement_channels")
      .insert(row)
      .select("*")
      .single();

    if (insertResult.error && isMissingAntispamChannelColumnError(insertResult.error)) {
      const { antispam_enabled, antispam_delete_links, ...compatibleRow } = row;
      insertResult = await this.supabase
        .from("max_engagement_channels")
        .insert(compatibleRow)
        .select("*")
        .single();
    }

    if (insertResult.error) {
      throw insertResult.error;
    }

    return {
      record: {
        ...mapChannel(insertResult.data as ChannelRow),
        communityType
      },
      created: true
    };
  }

  private async importMessageCreatedUpdate(
    channel: MaxEngagementChannelRecord,
    update: MaxUpdate
  ): Promise<boolean> {
    if (update.message?.recipient?.chat_type === "chat") {
      const message = update.message;
      const text = message?.body?.text?.trim() ?? "";
      const messageId = message?.body?.mid;
      const attachments = Array.isArray(message?.body?.attachments) ? message.body.attachments : [];

      if (!message || !messageId || (!text && attachments.length === 0)) {
        return false;
      }

      const senderId = message.sender?.user_id;
      const postedAt =
        typeof message.timestamp === "number"
          ? new Date(message.timestamp).toISOString()
          : new Date(update.timestamp ?? Date.now()).toISOString();

      const row = {
        channel_id: channel.id,
        max_message_id: String(messageId),
        author_user_id:
          senderId === undefined || senderId === null
            ? null
            : String(senderId),
        author_name: getSenderName(message.sender),
        author_is_bot: Boolean(message.sender?.is_bot),
        text,
        attachments,
        posted_at: postedAt,
        linked_text:
          buildChatLinkText(message),
        reply_to_max_message_id:
          message.link?.mid ?? message.link?.message?.body?.mid ?? null
      };

      const { error } = await this.supabase
        .from("max_engagement_chat_messages")
        .upsert(row, { onConflict: "channel_id,max_message_id", ignoreDuplicates: true });

      if (error) {
        if (isMissingLinkedTextColumnError(error)) {
          const { linked_text, ...compatibleRow } = row;
          const retry = await this.supabase
            .from("max_engagement_chat_messages")
            .upsert(compatibleRow, { onConflict: "channel_id,max_message_id", ignoreDuplicates: true });
          if (retry.error) {
            throw retry.error;
          }
        } else {
          throw error;
        }
      }

      return true;
    }

    const message = update.message;
    const text = message?.body?.text?.trim();
    const messageId = message?.body?.mid;

    if (
      !message ||
      !messageId ||
      !text
    ) {
      return false;
    }

    const senderId =
      message.sender?.user_id;

    const senderName =
      getSenderName(message.sender);

    const postedAt =
      typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : new Date(
            update.timestamp ?? Date.now()
          ).toISOString();

    const linkedMessageId =
      message.link?.mid ??
      message.link?.message?.body?.mid ??
      null;

    if (!linkedMessageId) {
      const post = await this.upsertMaxPost(
        channel,
        {
          id: String(messageId),
          channelId: channel.maxChannelId,
          text,
          url: message.url ?? undefined,
          authorName:
            senderName ?? undefined,
          postedAt,
          commentsCount:
            message.stat?.comments ?? 0,
          reactionsCount:
            message.stat?.reactions ??
            message.stat?.likes
        }
      );

      await this.upsertMaxThread(
        channel.id,
        post.id,
        String(messageId)
      );

      return true;
    }

    const post = await this.upsertMaxPost(
      channel,
      {
        id: String(linkedMessageId),
        channelId: channel.maxChannelId,
        text:
          message.link?.message?.body?.text ??
          "MAX post from linked message",
        url:
          message.url ?? undefined,
        authorName:
          getSenderName(
            message.link?.sender
          ) ?? undefined,
        postedAt,
        commentsCount:
          nullToUndefined(
            message.stat?.comments
          ),
        reactionsCount:
          nullToUndefined(
            message.stat?.reactions ??
            message.stat?.likes
          )
      }
    );

    const thread =
      await this.upsertMaxThread(
        channel.id,
        post.id,
        String(linkedMessageId)
      );

    await this.upsertMaxComment(
      channel.id,
      post.id,
      thread.id,
      {
        id: String(messageId),
        postId: String(linkedMessageId),
        threadId: String(linkedMessageId),
        authorUserId:
          senderId === undefined ||
          senderId === null
            ? undefined
            : String(senderId),
        authorName:
          senderName ?? undefined,
        text,
        postedAt
      }
    );

    return true;
  }

  private async listProcessedTriggerIds(
    triggerIds: string[]
  ): Promise<Set<string>> {
    if (triggerIds.length === 0) {
      return new Set();
    }

    const { data, error } = await this.supabase
      .from("max_engagement_bot_actions")
      .select("trigger_comment_id")
      .in("trigger_comment_id", triggerIds);

    if (error) {
      throw error;
    }

    const ids = (data ?? [])
      .map(
        (row: {
          trigger_comment_id: string | null;
        }) => row.trigger_comment_id
      )
      .filter(
        (id): id is string =>
          typeof id === "string"
      );

    return new Set(ids);
  }

  private async listInitiativePostIds(
    postIds: string[]
  ): Promise<Set<string>> {
    if (postIds.length === 0) {
      return new Set();
    }

    const { data, error } = await this.supabase
      .from("max_engagement_bot_actions")
      .select("post_id")
      .eq("action_type", "initiative")
      .in("post_id", postIds);

    if (error) {
      throw error;
    }

    const ids = (data ?? [])
      .map(
        (row: {
          post_id: string | null;
        }) => row.post_id
      )
      .filter(
        (id): id is string =>
          typeof id === "string"
      );

    return new Set(ids);
  }
}

function mapChannel(
  row: ChannelRow
): MaxEngagementChannelRecord {
  const platform = row.platform === "telegram" ? "telegram" : "max";
  const communityType = inferCommunityType(row);
  const isMaxChat = platform === "max" && communityType === "chat";

  return {
    id: String(row.id),
    platform,
    maxChannelId: String(row.max_channel_id),
    title: String(row.title),
    channelKind:
      row.channel_kind as MaxEngagementChannelRecord["channelKind"],
    communityType,
    enabled: Boolean(row.enabled),
    antispamEnabled:
      isMaxChat
        ? true
        : row.antispam_enabled === undefined
        ? envEnablesAntispam(String(row.max_channel_id))
        : Boolean(row.antispam_enabled) || envEnablesAntispam(String(row.max_channel_id)),
    antispamDeleteLinks:
      isMaxChat
        ? true
        : row.antispam_delete_links === undefined
        ? envEnablesAntispamDeleteLinks(String(row.max_channel_id))
        : Boolean(row.antispam_delete_links),
    mode:
      row.mode as MaxEngagementMode,
    teasingLevel:
      toTeasingLevel(row.teasing_level),
    level3Acknowledged:
      Boolean(row.level_3_acknowledged_at),
    level3ReviewPolicy:
      (
        row.level_3_review_policy === "post_moderation"
          ? "post_moderation"
          : "draft_required"
      ),
    replyLimitHour:
      numberOrDefault(
        row.reply_limit_hour,
        20
      ),
    replyLimitDay:
      numberOrDefault(
        row.reply_limit_day,
        120
      ),
    initiativeLimitHour:
      numberOrDefault(
        row.initiative_limit_hour,
        3
      ),
    initiativeLimitDay:
      numberOrDefault(
        row.initiative_limit_day,
        15
      ),
    userTeaseLimitDay:
      numberOrDefault(
        row.user_tease_limit_day,
        1
      ),
    politicsTeasingLevel:
      toTeasingLevel(
        row.politics_teasing_level
      ),
    dryRun:
      row.dry_run === undefined
        ? true
        : Boolean(row.dry_run),
    botName:
      typeof row.bot_name === "string"
        ? row.bot_name
        : undefined,
    botSignature:
      typeof row.bot_signature === "string"
        ? row.bot_signature
        : undefined
  };
}

function mapChatMessage(
  row: ChatMessageRow
): MaxEngagementChatMessageRecord {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    maxMessageId: String(row.max_message_id),
    authorUserId:
      typeof row.author_user_id === "string" ? row.author_user_id : null,
    authorName:
      typeof row.author_name === "string" ? row.author_name : null,
    authorIsBot: Boolean(row.author_is_bot),
    text: typeof row.text === "string" ? row.text : "",
    rawAttachments: Array.isArray(row.attachments) ? row.attachments : [],
    postedAt:
      typeof row.posted_at === "string" ? row.posted_at : null,
    replyToMaxMessageId:
      typeof row.reply_to_max_message_id === "string"
        ? row.reply_to_max_message_id
        : null,
    linkedText:
      typeof row.linked_text === "string" ? row.linked_text : null,
    processedAt:
      typeof row.processed_at === "string" ? row.processed_at : null
  };
}

function mapContactDirectoryRecord(row: Record<string, unknown>): ContactDirectoryRecord {
  return {
    id: String(row.id),
    cityId: typeof row.city_id === "string" ? row.city_id : null,
    channelId: String(row.channel_id),
    category: String(row.category),
    normalizedCategory: String(row.normalized_category ?? row.category ?? ""),
    contactName: typeof row.contact_name === "string" ? row.contact_name : null,
    phone: typeof row.phone === "string" ? row.phone : null,
    normalizedPhone: typeof row.normalized_phone === "string" ? row.normalized_phone : null,
    maxContactId: typeof row.max_contact_id === "string" ? row.max_contact_id : null,
    rawAttachment: row.raw_attachment,
    sourceMessageId: String(row.source_message_id),
    sourceAuthorName: typeof row.source_author_name === "string" ? row.source_author_name : null,
    sourceContext: typeof row.source_context === "string" ? row.source_context : "",
    firstSeenAt: typeof row.first_seen_at === "string" ? row.first_seen_at : null,
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    timesShared: numberOrDefault(row.times_shared, 1)
  };
}

function mapComment(
  row: CommentRow
): MaxEngagementCommentRecord {
  return {
    id: String(row.id),
    channelId:
      String(row.channel_id),
    postId:
      String(row.post_id),
    threadId:
      typeof row.thread_id === "string"
        ? row.thread_id
        : null,
    maxCommentId:
      typeof row.max_comment_id === "string"
        ? row.max_comment_id
        : null,
    authorUserId:
      typeof row.author_user_id === "string"
        ? row.author_user_id
        : null,
    authorName:
      typeof row.author_name === "string"
        ? row.author_name
        : null,
    text:
      String(row.text),
    postedAt:
      typeof row.posted_at === "string"
        ? row.posted_at
        : null
  };
}

function buildChatLinkText(message: NonNullable<MaxUpdate["message"]>): string | null {
  const parts = [
    message.link?.message?.body?.text?.trim() || null,
    extractLinkMetadataText({
      body: message.body,
      url: message.url,
      link: message.link
    })
  ].filter((item): item is string => Boolean(item));

  return parts.length > 0 ? parts.join("\n") : null;
}

function mapPost(
  row: PostRow
): MaxEngagementPostRecord {
  return {
    id:
      String(row.id),
    channelId:
      String(row.channel_id),
    maxPostId:
      String(row.max_post_id),
    text:
      typeof row.text === "string"
        ? row.text
        : null,
    classification:
      (
        row.classification ??
        "unknown"
      ) as MaxEngagementPostClassification,
    classificationConfidence:
      Number(
        row.classification_confidence ?? 0
      ),
    postedAt:
      typeof row.posted_at === "string"
        ? row.posted_at
        : null
  };
}

function mapThread(
  row: ThreadRow
): MaxEngagementThreadRecord {
  return {
    id:
      String(row.id),
    channelId:
      String(row.channel_id),
    postId:
      String(row.post_id),
    maxThreadId:
      String(row.max_thread_id),
    status:
      (
        row.status ?? "active"
      ) as MaxEngagementThreadStatus
  };
}

function inferCommunityType(
  row: ChannelRow
): MaxEngagementChannelRecord["communityType"] {
  if (
    row.community_type === "chat" ||
    row.community_type === "channel"
  ) {
    return row.community_type;
  }

  const title =
    String(row.title ?? "").toLowerCase();

  return title.startsWith("max чат")
    ? "chat"
    : "channel";
}

function envEnablesAntispam(maxChannelId: string): boolean {
  const value = process.env.MAX_ANTISPAM_ENABLED_CHAT_IDS || "";
  return listEnvContains(value, maxChannelId);
}

function envEnablesAntispamDeleteLinks(maxChannelId: string): boolean {
  const value = process.env.MAX_ANTISPAM_DELETE_LINKS_CHAT_IDS;
  if (!value) {
    return true;
  }

  return listEnvContains(value, maxChannelId);
}

function listEnvContains(value: string, item: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (["1", "true", "yes", "all", "*"].includes(normalized)) {
    return true;
  }

  return normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(item.toLowerCase());
}

function isMissingLinkedTextColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return message.includes("linked_text");
}

function isMissingAntispamChannelColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return message.includes("antispam_enabled") || message.includes("antispam_delete_links");
}

function getSenderName(
  sender: NonNullable<MaxUpdate["message"]>["sender"] | undefined
): string | null {
  if (!sender) {
    return null;
  }

  const directName =
    sender.name?.trim();

  if (directName) {
    return directName;
  }

  const fullName = [
    sender.first_name?.trim(),
    sender.last_name?.trim()
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (fullName) {
    return fullName;
  }

  return sender.username?.trim() || null;
}

function toTeasingLevel(
  value: unknown
): TeasingLevel {
  const numeric = Number(value);

  if (numeric >= 3) {
    return 3;
  }

  if (numeric >= 2) {
    return 2;
  }

  if (numeric >= 1) {
    return 1;
  }

  return 0;
}

function numberOrDefault(
  value: unknown,
  fallback: number
): number {
  const numeric = Number(value);

  return Number.isFinite(numeric)
    ? numeric
    : fallback;
}

function compareIsoDesc(left: string | null, right: string | null): number {
  return new Date(right ?? 0).getTime() - new Date(left ?? 0).getTime();
}

function nullToUndefined(
  value: number | null | undefined
): number | undefined {
  return typeof value === "number"
    ? value
    : undefined;
}
