import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { pool } from "./db.js";
import { generateSeoPage } from "./openai-seo.js";
import { createShopifyPage } from "./shopify.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS seo_keywords (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL UNIQUE,
        category TEXT,
        url_target TEXT,
        priority TEXT DEFAULT 'media',
        status TEXT DEFAULT 'pending',
        generated_title TEXT,
        generated_handle TEXT,
        meta_title TEXT,
        meta_description TEXT,
        html_body TEXT,
        shopify_page_id TEXT,
        published_url TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        generated_at TIMESTAMP,
        published_at TIMESTAMP
      );
    `);

    console.log("Tabella seo_keywords pronta");
  } catch (error) {
    console.error("Errore inizializzazione database:", error);
  }
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/**
 * HOME
 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Vistora Tools",
    modules: ["Google Reviews Proxy", "SEO Page Generator"]
  });
});

/**
 * GOOGLE REVIEWS PROXY - ESISTENTE
 */
app.get("/debug-key", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || "";

  res.json({
    hasKey: !!key,
    keyPrefix: key ? key.slice(0, 6) : null
  });
});

app.get("/google-reviews", async (req, res) => {
  const placeId = req.query.place_id;

  if (!placeId) {
    return res.status(400).json({ error: "Missing place_id" });
  }

  try {
    const googleUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;

    const googleRes = await fetch(googleUrl, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "displayName,rating,userRatingCount,reviews"
      }
    });

    const rawText = await googleRes.text();

    if (!googleRes.ok) {
      return res.status(googleRes.status).json({
        error: "Google API error",
        details: rawText
      });
    }

    const place = JSON.parse(rawText);

    const payload = {
      name: place?.displayName?.text || "",
      rating: place?.rating || null,
      userRatingCount: place?.userRatingCount || 0,
      reviews: Array.isArray(place?.reviews)
        ? place.reviews.slice(0, 5).map((review) => ({
            author: review?.authorAttribution?.displayName || "Utente Google",
            rating: review?.rating || 5,
            text: review?.originalText?.text || review?.text?.text || "",
            relativeTimeDescription: review?.relativePublishTimeDescription || ""
          }))
        : []
    };

    res.set("Cache-Control", "public, max-age=1800");
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: String(error)
    });
  }
});

/**
 * SEO DASHBOARD SEMPLICE
 */
app.get("/seo", async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'generated') AS generated,
        COUNT(*) FILTER (WHERE status = 'published') AS published,
        COUNT(*) FILTER (WHERE status = 'error') AS error
      FROM seo_keywords
    `);

    const latest = await pool.query(`
      SELECT id, keyword, category, status, published_url, error_message, created_at, published_at
      FROM seo_keywords
      ORDER BY id DESC
      LIMIT 50
    `);

    res.json({
      ok: true,
      stats: stats.rows[0],
      latest: latest.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

/**
 * IMPORT DA TEXTAREA
 */
app.post("/seo/import-text", async (req, res) => {
  const { text, category, url_target, priority } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Missing text" });
  }

  const keywords = text
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean);

  let inserted = 0;
  let skipped = 0;

  for (const keyword of keywords) {
    try {
      await pool.query(
        `
        INSERT INTO seo_keywords 
          (keyword, category, url_target, priority, status)
        VALUES 
          ($1, $2, $3, $4, 'pending')
        ON CONFLICT (keyword) DO NOTHING
        `,
        [
          keyword,
          category || null,
          url_target || "https://vistora.it/",
          priority || "media"
        ]
      );

      inserted++;
    } catch (error) {
      skipped++;
    }
  }

  res.json({
    ok: true,
    inserted,
    skipped,
    total_received: keywords.length
  });
});

/**
 * IMPORT DA CSV
 *
 * CSV consigliato:
 * keyword,category,url_target,priority
 */
app.post("/seo/import-csv", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing CSV file" });
  }

  try {
    const csvText = req.file.buffer.toString("utf8");

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    let inserted = 0;
    let skipped = 0;

    for (const record of records) {
      const keyword = record.keyword?.trim();

      if (!keyword) {
        skipped++;
        continue;
      }

      await pool.query(
        `
        INSERT INTO seo_keywords 
          (keyword, category, url_target, priority, status)
        VALUES 
          ($1, $2, $3, $4, 'pending')
        ON CONFLICT (keyword) DO NOTHING
        `,
        [
          keyword,
          record.category || null,
          record.url_target || "https://vistora.it/",
          record.priority || "media"
        ]
      );

      inserted++;
    }

    res.json({
      ok: true,
      inserted,
      skipped,
      total_received: records.length
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

/**
 * LISTA KEYWORD
 */
app.get("/seo/keywords", async (req, res) => {
  const status = req.query.status;

  try {
    const result = status
      ? await pool.query(
          `
          SELECT * FROM seo_keywords
          WHERE status = $1
          ORDER BY id DESC
          LIMIT 200
          `,
          [status]
        )
      : await pool.query(
          `
          SELECT * FROM seo_keywords
          ORDER BY id DESC
          LIMIT 200
          `
        );

    res.json({
      ok: true,
      keywords: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

/**
 * GENERA UNA PAGINA SENZA PUBBLICARE
 */
app.post("/seo/generate/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const result = await pool.query(
      `SELECT * FROM seo_keywords WHERE id = $1`,
      [id]
    );

    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({ error: "Keyword not found" });
    }

    const generated = await generateSeoPage({
      keyword: row.keyword,
      category: row.category,
      urlTarget: row.url_target
    });

    if (!generated.html_body || generated.html_body.length < 3000) {
      throw new Error("Contenuto generato inferiore a 3000 caratteri");
    }

    await pool.query(
      `
      UPDATE seo_keywords
      SET status = 'generated',
          generated_title = $1,
          generated_handle = $2,
          meta_title = $3,
          meta_description = $4,
          html_body = $5,
          generated_at = NOW(),
          error_message = NULL
      WHERE id = $6
      `,
      [
        generated.title,
        generated.handle,
        generated.meta_title,
        generated.meta_description,
        generated.html_body,
        id
      ]
    );

    res.json({
      ok: true,
      generated
    });
  } catch (error) {
    await pool.query(
      `
      UPDATE seo_keywords
      SET status = 'error',
          error_message = $1
      WHERE id = $2
      `,
      [String(error), id]
    );

    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

/**
 * PUBBLICA UNA PAGINA GIÀ GENERATA
 */
app.post("/seo/publish/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const result = await pool.query(
      `SELECT * FROM seo_keywords WHERE id = $1`,
      [id]
    );

    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({ error: "Keyword not found" });
    }

    if (!row.html_body) {
      return res.status(400).json({ error: "Page not generated yet" });
    }

    const page = await createShopifyPage({
      title: row.generated_title,
      handle: row.generated_handle,
      meta_title: row.meta_title,
      meta_description: row.meta_description,
      html_body: row.html_body
    });

    const publishedUrl = `https://vistora.it/pages/${row.generated_handle}`;

    await pool.query(
      `
      UPDATE seo_keywords
      SET status = 'published',
          shopify_page_id = $1,
          published_url = $2,
          published_at = NOW(),
          error_message = NULL
      WHERE id = $3
      `,
      [page.id, publishedUrl, id]
    );

    res.json({
      ok: true,
      page,
      published_url: publishedUrl
    });
  } catch (error) {
    await pool.query(
      `
      UPDATE seo_keywords
      SET status = 'error',
          error_message = $1
      WHERE id = $2
      `,
      [String(error), id]
    );

    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

/**
 * CRON MANUALE/RENDER
 */
app.post("/seo/cron", async (req, res) => {
  const secret = req.headers["x-cron-secret"];

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const limit = Number(process.env.DAILY_LIMIT || 5);

  try {
    const result = await pool.query(
      `
      SELECT * FROM seo_keywords
      WHERE status = 'pending'
      ORDER BY
        CASE priority
          WHEN 'alta' THEN 1
          WHEN 'media' THEN 2
          ELSE 3
        END,
        created_at ASC
      LIMIT $1
      `,
      [limit]
    );

    const processed = [];

    for (const row of result.rows) {
      try {
        const generated = await generateSeoPage({
          keyword: row.keyword,
          category: row.category,
          urlTarget: row.url_target
        });

        if (!generated.html_body || generated.html_body.length < 3000) {
          throw new Error("Contenuto generato inferiore a 3000 caratteri");
        }

        const page = await createShopifyPage(generated);
        const publishedUrl = `https://vistora.it/pages/${generated.handle}`;

        await pool.query(
          `
          UPDATE seo_keywords
          SET status = 'published',
              generated_title = $1,
              generated_handle = $2,
              meta_title = $3,
              meta_description = $4,
              html_body = $5,
              shopify_page_id = $6,
              published_url = $7,
              generated_at = NOW(),
              published_at = NOW(),
              error_message = NULL
          WHERE id = $8
          `,
          [
            generated.title,
            generated.handle,
            generated.meta_title,
            generated.meta_description,
            generated.html_body,
            page.id,
            publishedUrl,
            row.id
          ]
        );

        processed.push({
          keyword: row.keyword,
          status: "published",
          url: publishedUrl
        });
      } catch (error) {
        await pool.query(
          `
          UPDATE seo_keywords
          SET status = 'error',
              error_message = $1
          WHERE id = $2
          `,
          [String(error), row.id]
        );

        processed.push({
          keyword: row.keyword,
          status: "error",
          error: String(error)
        });
      }
    }

    res.json({
      ok: true,
      processed
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.post("/seo/init-db", async (req, res) => {
  const secret = req.headers["x-cron-secret"];

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS seo_keywords (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL UNIQUE,
        category TEXT,
        url_target TEXT,
        priority TEXT DEFAULT 'media',
        status TEXT DEFAULT 'pending',
        generated_title TEXT,
        generated_handle TEXT,
        meta_title TEXT,
        meta_description TEXT,
        html_body TEXT,
        shopify_page_id TEXT,
        published_url TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        generated_at TIMESTAMP,
        published_at TIMESTAMP
      );
    `);

    res.json({
      ok: true,
      message: "Tabella seo_keywords creata o già esistente"
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});



const port = process.env.PORT || 10000;

initDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
});
