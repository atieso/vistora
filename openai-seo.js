import OpenAI from "openai";
import { buildSeoPrompt } from "./prompts/seo-page.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function generateSeoPage({ keyword, category, urlTarget }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  if (!keyword) {
    throw new Error("Missing keyword");
  }

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
          "Sei un copywriter SEO italiano specializzato in ecommerce Shopify. Devi generare pagine SEO originali, commerciali, utili e non duplicate. Rispondi esclusivamente con JSON valido, senza markdown e senza testo fuori dal JSON."
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

  parsed.title = cleanText(parsed.title).slice(0, 90);
  parsed.meta_title = cleanText(parsed.meta_title).slice(0, 70);
  parsed.meta_description = cleanText(parsed.meta_description).slice(0, 170);
  parsed.handle = normalizeHandle(parsed.handle || keyword);
  parsed.html_body = String(parsed.html_body || "").trim();

  if (parsed.html_body.length < 3000) {
    throw new Error(
      `Contenuto generato inferiore a 3000 caratteri: ${parsed.html_body.length}`
    );
  }

  if (!parsed.html_body.includes("<h1")) {
    throw new Error("Il contenuto generato non contiene un H1 HTML");
  }

  if (!parsed.html_body.includes("<h2")) {
    throw new Error("Il contenuto generato non contiene H2 HTML");
  }

  return parsed;
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHandle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}
