import type {
  MaxEngagementChannelRecord,
  MaxEngagementCommentRecord,
  MaxEngagementDecision,
  MaxEngagementGeneratedDraft,
  MaxEngagementPostRecord
} from "./types.js";

export function generateDryRunDraft(input: {
  channel: MaxEngagementChannelRecord;
  comment: MaxEngagementCommentRecord;
  decision: MaxEngagementDecision;
  post: MaxEngagementPostRecord | null;
}): MaxEngagementGeneratedDraft {
  const { channel, comment, decision, post } = input;
  const author = comment.authorName?.trim() || "вы";
  const suffix = channel.botSignature ? `\n\n${channel.botSignature}` : "";

  if (decision.actionType === "stop_thread") {
    return {
      text: "",
      safetyReason: `${decision.reason}; no public reply generated`
    };
  }

  if (decision.actionType === "moderate") {
    return {
      text: "",
      safetyReason: `${decision.reason}; moderation action only`
    };
  }

  if (decision.finalTeasingLevel === 0) {
    return {
      text: `${author}, поняли вас. Давайте без накала: по сути вопроса тут важнее разобраться спокойно.${suffix}`,
      safetyReason: `Neutral draft for ${post?.classification ?? "unknown"} post`
    };
  }

  if (decision.finalTeasingLevel === 1) {
    return {
      text: `${author}, вот это поворот 😄 Но мысль понятная: тема явно зацепила не только вас.${suffix}`,
      safetyReason: "Friendly light irony; no personal attack"
    };
  }

  if (decision.finalTeasingLevel === 2) {
    return {
      text: `${author}, ситуация из серии \"ну конечно, а как иначе\". Но если серьезно, тут правда есть что обсудить.${suffix}`,
      safetyReason: "Topic-level tease; not aimed at the commenter"
    };
  }

  return {
    text: `${author}, звучит уверенно. Даже слишком уверенно для комментариев, где через два ответа обычно выясняется нюанс 😏${suffix}`,
    safetyReason: "Level 3 draft requires admin review before posting"
  };
}
