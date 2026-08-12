import { describe, expect, it } from "vitest";

import { parseCityMemoryExtraction } from "./city-memory-extractor.js";

describe("city memory extractor", () => {
  it("parses resident shop recommendations and keeps them unverified", () => {
    const candidates = parseCityMemoryExtraction(JSON.stringify({
      candidates: [
        {
          object_type: "organization",
          object_name: "Peppi",
          aliases: ["Peppi", "peppi"],
          categories: ["school clothes", "shop"],
          related_terms: ["first grade", "uniform", "Ozon comparison"],
          knowledge_kind: "resident_recommendation",
          content: "A resident reported buying school clothes in Peppi for about 10000; they considered prices mostly adequate, while Ozon was cheaper.",
          confidence: 0.92,
          valid_until: null
        }
      ]
    }));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      objectType: "organization",
      objectName: "Peppi",
      knowledgeKind: "resident_recommendation",
      trust: "single_resident"
    });
    expect(candidates[0].confidence).toBe(0.75);
    expect(candidates[0].content).toContain("resident reported");
  });

  it("accepts no candidates for low-value chat", () => {
    expect(parseCityMemoryExtraction(JSON.stringify({ candidates: [] }))).toEqual([]);
  });

  it("rejects unsupported fields from model output", () => {
    expect(() => parseCityMemoryExtraction(JSON.stringify({
      candidates: [
        {
          object_type: "organization",
          object_name: "Korobka",
          aliases: [],
          categories: [],
          related_terms: [],
          knowledge_kind: "resident_recommendation",
          content: "A resident reported buying school clothes in Korobka.",
          confidence: 0.6,
          valid_until: null,
          verified: true
        }
      ]
    }))).toThrow(/unsupported fields/);
  });
});
