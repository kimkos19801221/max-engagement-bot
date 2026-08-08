export type CityMemoryObjectType =
  | "organization"
  | "institution"
  | "place"
  | "service"
  | "event"
  | "temporary_change"
  | "recommendation"
  | "topic";

export type CityMemoryKnowledgeKind =
  | "address"
  | "contact"
  | "service"
  | "hours"
  | "event"
  | "temporary_change"
  | "resident_recommendation"
  | "correction"
  | "summary";

export type CityMemorySourceTrust =
  | "official"
  | "admin"
  | "multi_resident"
  | "single_resident"
  | "disputed"
  | "stale";

export type CityMemoryReviewStatus = "active" | "needs_review" | "blocked" | "deleted";

export type CityMemoryCityRecord = {
  id: string;
  name: string;
  createdAt: string;
};

export type CityMemoryPublicRecord = {
  id: string;
  cityId: string;
  channelId: string;
  title: string;
  createdAt: string;
};

export type CityMemoryObjectRecord = {
  id: string;
  cityId: string;
  publicId: string;
  type: CityMemoryObjectType;
  canonicalName: string;
  aliases: string[];
  categories: string[];
  relatedTerms: string[];
  mergedIntoId: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type CityMemorySourceRecord = {
  id: string;
  cityId: string;
  publicId: string;
  channelId: string;
  sourceType: "post" | "comment" | "admin" | "manual" | "system";
  sourceId: string;
  authorName: string | null;
  textExcerpt: string;
  url: string | null;
  receivedAt: string;
};

export type CityMemoryKnowledgeRecord = {
  id: string;
  cityId: string;
  publicId: string;
  objectId: string;
  kind: CityMemoryKnowledgeKind;
  content: string;
  normalizedContent: string;
  sourceIds: string[];
  receivedAt: string;
  lastVerifiedAt: string | null;
  validUntil: string | null;
  confidence: number;
  trust: CityMemorySourceTrust;
  confirmations: number;
  refutations: number;
  status: CityMemoryReviewStatus;
  contradictionGroupId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CityMemoryRevisionRecord = {
  id: string;
  knowledgeId: string;
  previousContent: string | null;
  nextContent: string;
  sourceId: string;
  changeType: "created" | "confirmed" | "corrected" | "refuted" | "merged" | "blocked";
  createdAt: string;
};

export type CityMemoryBlockedItemRecord = {
  id: string;
  cityId: string | null;
  publicId: string | null;
  sourceId: string | null;
  reason: string;
  textExcerpt: string;
  createdAt: string;
};

export type CityMemoryConversationSummaryRecord = {
  id: string;
  cityId: string;
  publicId: string;
  threadId: string | null;
  summary: string;
  sourceMessageIds: string[];
  createdAt: string;
};

export type CityMemoryState = {
  cities: CityMemoryCityRecord[];
  publics: CityMemoryPublicRecord[];
  objects: CityMemoryObjectRecord[];
  knowledge: CityMemoryKnowledgeRecord[];
  sources: CityMemorySourceRecord[];
  revisions: CityMemoryRevisionRecord[];
  blockedItems: CityMemoryBlockedItemRecord[];
  conversationSummaries: CityMemoryConversationSummaryRecord[];
};


export type CityMemoryCandidate = {
  objectType: CityMemoryObjectType;
  objectName: string;
  aliases: string[];
  categories: string[];
  relatedTerms: string[];
  knowledgeKind: CityMemoryKnowledgeKind;
  content: string;
  confidence: number;
  trust: CityMemorySourceTrust;
  validUntil: string | null;
};

export type CityMemoryIngestInput = {
  cityName: string;
  channelId: string;
  publicTitle: string;
  sourceType: CityMemorySourceRecord["sourceType"];
  sourceId: string;
  authorName?: string | null;
  text: string;
  url?: string | null;
  receivedAt?: string | null;
};

export type CityMemoryIngestResult = {
  sources: number;
  objects: number;
  knowledge: number;
  blocked: number;
  revisions: number;
};

export type CityMemorySearchResult = {
  object: CityMemoryObjectRecord;
  knowledge: CityMemoryKnowledgeRecord[];
  score: number;
  answerPrefix: string;
};
