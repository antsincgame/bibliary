export async function recognizeWithVisionLlm(
  imageBuffer: Buffer,
  opts: {
    apiKey?: string;
    languages?: string[];
    signal?: AbortSignal;
    model?: string;
    mimeType?: string;
  } = {},
): Promise<{ text: string; confidence: number }> {
  const apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY || "";
  if (!apiKey) {
    throw new Error("vision-llm OCR requires OPENROUTER_API_KEY or preferences.openrouterApiKey");
  }

  const model = opts.model || process.env.OPENROUTER_OCR_MODEL || "google/gemini-2.0-flash-exp:free";
  const mimeType = opts.mimeType || "image/png";
  const languages = (opts.languages || []).filter(Boolean).join(", ");
  const prompt = [
    "Extract plain text from the scanned book page image.",
    "Return only text, no explanations, no markdown.",
    languages ? `Preferred languages: ${languages}.` : "Detect language automatically.",
  ].join(" ");

  const body = {
    model,
    temperature: 0,
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBuffer.toString("base64")}` } },
        ],
      },
    ],
  };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`openrouter ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = (json.choices?.[0]?.message?.content || "").trim();
  return { text, confidence: text ? 0.9 : 0 };
}
