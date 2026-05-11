import OpenAI from "openai";
import { buildSeoPrompt } from "./prompts/seo-page.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function generateSeoPage({ keyword, category, urlTarget }) {
  const prompt = buildSeoPrompt({
    keyword,
    category,
    urlTarget
  });

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "Sei un copywriter SEO italiano specializzato in ecommerce Shopify. Rispondi solo con JSON valido."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    response_format: {
      type: "json_object"
    }
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Risposta OpenAI vuota");
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Risposta OpenAI non è JSON valido");
  }

  const requiredFields = [
    "title",
    "handle",
    "meta_title",
    "meta_description",
    "html_body"
  ];

  for (const field of requiredFields) {
    if (!parsed[field]) {
      throw new Error(`Campo mancante: ${field}`);
    }
  }

  parsed.handle = normalizeHandle(parsed.handle || keyword);

  return parsed;
}

function normalizeHandle(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}
