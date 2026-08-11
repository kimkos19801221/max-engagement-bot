import "jsr:@supabase/functions-js/edge-runtime.d.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: { message: "method_not_allowed" } }, 405);
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return json({ error: { message: "missing_openai_api_key" } }, 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: "invalid_json" } }, 400);
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  });
});
