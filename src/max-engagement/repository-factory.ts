import { LocalEngagementRepository } from "./local-repository.js";
import {
  MaxEngagementRepository,
  createSupabaseClientFromEnv,
  type EngagementRepository
} from "./repository.js";

export type RuntimeEngagementRepository = EngagementRepository & {
  getMaxPollingMarker(): Promise<number | null>;
  setMaxPollingMarker(marker: number | null): Promise<void>;
  importMaxUpdates(updates: Parameters<EngagementRepository["importMaxUpdates"]>[0]): ReturnType<EngagementRepository["importMaxUpdates"]>;
};

export function createEngagementRepositoryFromEnv(): RuntimeEngagementRepository {
  const storage = (process.env.ENGAGEMENT_STORAGE || "local").trim().toLowerCase();

  if (storage === "supabase") {
    return new MaxEngagementRepository(createSupabaseClientFromEnv());
  }

  if (storage !== "local") {
    throw new Error(`Unsupported ENGAGEMENT_STORAGE: ${storage}`);
  }

  return new LocalEngagementRepository();
}