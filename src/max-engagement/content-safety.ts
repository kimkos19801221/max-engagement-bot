import type { MaxEngagementPostClassification } from "./types.js";

const STOP_TRIGGER_PATTERNS = [
  /самоуб/i,
  /суицид/i,
  /самоповреж/i,
  /не хочу жить/i,
  /груб[оая]/i,
  /обидн[оая]/i,
  /оскорб/i,
  /перебор/i,
  /удалите/i,
  /пожалуюсь/i,
  /жалоб[ауые]?\s+(на|админ|бот|вас|комментар)/i,
  /буду\s+жаловаться/i
];

const QUESTION_PATTERN = /[?？]|\b(кто|что|где|когда|почему|зачем|как|сколько|куда|откуда|какой|какая|какие)\b/i;

const SENSITIVE_CLASSIFICATION_PATTERNS: Array<[MaxEngagementPostClassification, RegExp]> = [
  ["child_harm", /реб[её]нок.*(умер|погиб|насили|болезн|травм)|дет[еи].*(умер|погиб|насили|болезн|травм)/i],
  ["death", /умер|погиб|смерт|скончал/i],
  ["violence", /насили|изби|нападен|уби(й|л)|стрельб/i],
  ["emergency", /чп|авари|дтп|пожар|катастроф|эвакуац/i],
  ["tragedy", /трагеди|горе|траур/i],
  ["politics", /выбор|депутат|губернатор|мэр|правительств|путин|войн|санкци/i],
  ["disputed", /скандал|конфликт|спор|митинг|протест/i]
];

export function hasStopTrigger(text: string): boolean {
  return STOP_TRIGGER_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeQuestion(text: string): boolean {
  return QUESTION_PATTERN.test(text);
}

export function classifyPostText(text: string | null | undefined): {
  classification: MaxEngagementPostClassification;
  confidence: number;
  reason: string;
} {
  const value = text?.trim();
  if (!value) {
    return {
      classification: "unknown",
      confidence: 0,
      reason: "No post text to classify"
    };
  }

  for (const [classification, pattern] of SENSITIVE_CLASSIFICATION_PATTERNS) {
    if (pattern.test(value)) {
      return {
        classification,
        confidence: 0.7,
        reason: `Keyword match: ${classification}`
      };
    }
  }

  return {
    classification: "neutral",
    confidence: 0.5,
    reason: "No sensitive keyword match"
  };
}
