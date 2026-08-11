export type OpenAIResponsesPayload = {
  model: string;
  instructions?: string;
  input: string;
  max_output_tokens: number;
  temperature?: number;
  text?: unknown;
};

export type OpenAIResponsesData = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
};

const OPENAI_URL = "https://api.openai.com/v1/responses";

export async function requestOpenAIResponses(input: {
  apiKey: string;
  payload: OpenAIResponsesPayload;
  signal: AbortSignal;
}): Promise<OpenAIResponsesData> {
  const proxyUrl = process.env.OPENAI_PROXY_URL?.trim();
  const proxyKey =
    process.env.OPENAI_PROXY_API_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim();

  if (proxyUrl && !proxyKey) {
    throw new Error("OPENAI_PROXY_API_KEY or Supabase secret key is required for OPENAI_PROXY_URL");
  }

  const response = await fetch(proxyUrl || OPENAI_URL, {
    method: "POST",
    headers: proxyUrl
      ? {
          Authorization: `Bearer ${proxyKey}`,
          apikey: proxyKey || "",
          "Content-Type": "application/json"
        }
      : {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json"
        },
    body: JSON.stringify(input.payload),
    signal: input.signal
  });

  const data = await response.json() as OpenAIResponsesData;
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI HTTP ${response.status}`);
  }
  return data;
}
