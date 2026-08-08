import { describe, expect, it } from "vitest";

import { createEmptyCityMemoryState, ingestCityMemory, searchCityMemory } from "./local-store.js";

describe("city memory", () => {
  it("finds related horse-riding concepts instead of only exact wording", () => {
    const state = createEmptyCityMemoryState();
    ingestCityMemory(state, {
      cityName: "Иркутск", channelId: "irk-public", publicTitle: "Мамочки Иркутска",
      sourceType: "comment", sourceId: "m1", authorName: "Анна",
      text: "Мы ходили в конный клуб Мустанг, там есть верховая езда и конные прогулки.",
      receivedAt: "2026-08-03T10:00:00.000Z"
    });
    const results = searchCityMemory(state, { cityName: "Иркутск", query: "Где покататься на лошадях?" });
    expect(results[0].object.relatedTerms).toContain("ипподром");
    expect(results[0].knowledge.some((item) => item.kind === "service")).toBe(true);
    expect(results[0].answerPrefix).toBe("Один из подписчиков писал");
  });

  it("creates categories for a new local service without a hard-coded profession list", () => {
    const state = createEmptyCityMemoryState();
    ingestCityMemory(state, {
      cityName: "Томск", channelId: "tomsk", publicTitle: "Детская барахолка Томска",
      sourceType: "comment", sourceId: "request-1",
      text: "Подскажите, где можно заказать ростовую куклу для детского сада?"
    });
    ingestCityMemory(state, {
      cityName: "Томск", channelId: "tomsk", publicTitle: "Детская барахолка Томска",
      sourceType: "comment", sourceId: "answer-1", authorName: "Елизавета",
      text: "Попробуйте в Потапыч позвонить. На Плеханова который.",
      receivedAt: "2026-08-05T04:40:00.000Z"
    });
    ingestCityMemory(state, {
      cityName: "Томск", channelId: "tomsk", publicTitle: "Детская барахолка Томска",
      sourceType: "comment", sourceId: "answer-2", authorName: "Елизавета",
      text: "У них не только изготовление, но и прокат костюмов есть.",
      receivedAt: "2026-08-05T04:42:00.000Z"
    });

    const results = searchCityMemory(state, { cityName: "Томск", query: "Где найти аниматора или ростовую куклу?" });
    const potapych = results.find((item) => item.object.canonicalName.toLowerCase().includes("потапыч"));
    expect(potapych).toBeDefined();
    expect(potapych?.object.categories).toContain("детские праздники");
    expect(potapych?.object.relatedTerms).toContain("прокат костюмов");
    expect(potapych?.answerPrefix).toBe("Один из подписчиков писал");
  });

  it("creates a dynamic category for an unfamiliar service request", () => {
    const state = createEmptyCityMemoryState();
    ingestCityMemory(state, {
      cityName: "Томск", channelId: "tomsk", publicTitle: "Томск",
      sourceType: "comment", sourceId: "rare-1",
      text: "Посоветуйте, где заказать реставрацию старого глобуса."
    });
    ingestCityMemory(state, {
      cityName: "Томск", channelId: "tomsk", publicTitle: "Томск",
      sourceType: "comment", sourceId: "rare-2",
      text: "Рекомендую мастерскую Глобус, они занимаются реставрацией старых глобусов."
    });
    const results = searchCityMemory(state, { cityName: "Томск", query: "реставрация глобуса" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((item) => item.object.categories.some((category) => category.includes("реставрац")))).toBe(true);
  });

  it("keeps different city memories isolated", () => {
    const state = createEmptyCityMemoryState();
    ingestCityMemory(state, { cityName: "Иркутск", channelId: "irk-public", publicTitle: "Иркутск", sourceType: "comment", sourceId: "irk-1", text: "Верховая езда есть в конном клубе Мустанг." });
    ingestCityMemory(state, { cityName: "Ангарск", channelId: "ang-public", publicTitle: "Ангарск", sourceType: "comment", sourceId: "ang-1", text: "Верховая езда есть в конном клубе Олимп." });
    const irkutsk = searchCityMemory(state, { cityName: "Иркутск", query: "лошади" });
    expect(irkutsk).toHaveLength(1);
    expect(irkutsk[0].object.canonicalName).not.toContain("Олимп");
  });

  it("raises confidence when residents confirm the same knowledge", () => {
    const state = createEmptyCityMemoryState();
    const text = "Конный клуб Мустанг работает с 10:00 до 19:00.";
    ingestCityMemory(state, { cityName: "Иркутск", channelId: "irk", publicTitle: "Иркутск", sourceType: "comment", sourceId: "1", text });
    ingestCityMemory(state, { cityName: "Иркутск", channelId: "irk", publicTitle: "Иркутск", sourceType: "comment", sourceId: "2", text });
    const hours = state.knowledge.find((item) => item.kind === "hours");
    expect(hours?.confirmations).toBe(2);
    expect(hours?.trust).toBe("multi_resident");
    expect(hours?.confidence).toBeGreaterThan(0.7);
  });

  it("blocks sensitive personal data instead of storing it as public knowledge", () => {
    const state = createEmptyCityMemoryState();
    const result = ingestCityMemory(state, {
      cityName: "Иркутск", channelId: "irk", publicTitle: "Иркутск", sourceType: "comment", sourceId: "private-1",
      text: "У врача плохой прием, вот личный телефон 89991234567."
    });
    expect(result.blocked).toBeGreaterThan(0);
    expect(state.knowledge).toHaveLength(0);
    expect(state.blockedItems[0].reason).toBe("personal_phone");
  });
});
