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

function getAdminSecret() {
  return process.env.ADMIN_SECRET || process.env.CRON_SECRET || "test123456789";
}

function isAuthorized(req) {
  const secret =
    req.query.secret ||
    req.body?.secret ||
    req.headers["x-admin-secret"] ||
    req.headers["x-cron-secret"];

  return secret === getAdminSecret();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusBadge(status) {
  const map = {
    pending: "badge pending",
    generated: "badge generated",
    published: "badge published",
    error: "badge error"
  };

  return `<span class="${map[status] || "badge"}">${escapeHtml(status)}</span>`;
}

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
 * GOOGLE REVIEWS PROXY
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
            relativeTimeDescription:
              review?.relativePublishTimeDescription || ""
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
 * DEBUG SHOPIFY
 */
app.get("/seo/debug-shopify", (req, res) => {
  const shop = process.env.SHOPIFY_SHOP || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";

  res.json({
    shop,
    apiVersion,
    endpoint: `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    hasToken: !!token,
    tokenPrefix: token ? token.slice(0, 6) : null
  });
});

/**
 * SEO DASHBOARD JSON SEMPLICE
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
 * PANNELLO HTML KEYWORDS
 */
app.get("/seo/keywords", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).send(`
      <h1>Accesso non autorizzato</h1>
      <p>Aggiungi il parametro <code>?secret=...</code> all'URL.</p>
    `);
  }

  const secret = req.query.secret || "";
  const status = req.query.status || "";
  const search = req.query.search || "";

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

    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(`keyword ILIKE $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT *
      FROM seo_keywords
      ${whereSql}
      ORDER BY id DESC
      LIMIT 300
      `,
      params
    );

    const s = stats.rows[0];

    const rows = result.rows
      .map((row) => {
        const publishedLink = row.published_url
          ? `<a href="${escapeHtml(row.published_url)}" target="_blank">Apri pagina</a>`
          : "-";

        const errorMessage = row.error_message
          ? `<details><summary>Errore</summary><pre>${escapeHtml(
              row.error_message
            )}</pre></details>`
          : "";

        const generateButton =
          row.status === "pending" || row.status === "error"
            ? `
              <form method="POST" action="/seo/admin-generate/${row.id}?secret=${encodeURIComponent(
                secret
              )}">
                <button class="btn small" type="submit">Genera</button>
              </form>
            `
            : "";

        const publishButton =
          row.status === "generated"
            ? `
              <form method="POST" action="/seo/admin-publish/${row.id}?secret=${encodeURIComponent(
                secret
              )}">
                <button class="btn small primary" type="submit">Pubblica</button>
              </form>
            `
            : "";

        return `
          <tr>
            <td>${row.id}</td>
            <td>
              <strong>${escapeHtml(row.keyword)}</strong>
              <div class="muted">${escapeHtml(row.category || "")}</div>
            </td>
            <td>${statusBadge(row.status)}</td>
            <td>${escapeHtml(row.priority || "media")}</td>
            <td>${escapeHtml(row.generated_title || "-")}</td>
            <td>${publishedLink}</td>
            <td>
              <div class="actions">
                ${generateButton}
                ${publishButton}
              </div>
              ${errorMessage}
            </td>
          </tr>
        `;
      })
      .join("");

    res.send(`
      <!doctype html>
      <html lang="it">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Vistora SEO Keywords</title>
        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #f6f3ee;
            color: #222;
          }

          .container {
            max-width: 1280px;
            margin: 0 auto;
            padding: 32px 20px;
          }

          .topbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            margin-bottom: 24px;
          }

          h1 {
            margin: 0;
            font-size: 30px;
            letter-spacing: -0.03em;
          }

          h2 {
            margin-top: 0;
          }

          .subtitle {
            margin-top: 6px;
            color: #666;
          }

          .grid {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            gap: 14px;
            margin-bottom: 24px;
          }

          .card {
            background: #fff;
            border-radius: 18px;
            padding: 18px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.06);
            border: 1px solid rgba(0,0,0,0.05);
          }

          .stat-number {
            font-size: 28px;
            font-weight: 700;
          }

          .stat-label {
            color: #666;
            margin-top: 4px;
            font-size: 14px;
          }

          .panel {
            background: #fff;
            border-radius: 18px;
            padding: 22px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.06);
            border: 1px solid rgba(0,0,0,0.05);
            margin-bottom: 24px;
          }

          textarea,
          input,
          select {
            width: 100%;
            box-sizing: border-box;
            border: 1px solid #ddd;
            border-radius: 12px;
            padding: 12px;
            font-size: 14px;
            background: #fff;
          }

          textarea {
            min-height: 150px;
            resize: vertical;
          }

          label {
            display: block;
            font-weight: 700;
            margin-bottom: 8px;
            font-size: 14px;
          }

          .form-grid {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 14px;
            margin-bottom: 14px;
          }

          .btn {
            border: 0;
            border-radius: 999px;
            background: #222;
            color: #fff;
            padding: 11px 18px;
            cursor: pointer;
            font-weight: 700;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
          }

          .btn:hover {
            opacity: 0.9;
          }

          .btn.primary {
            background: #8b5e3c;
          }

          .btn.secondary {
            background: #fff;
            color: #222;
            border: 1px solid #ddd;
          }

          .btn.small {
            padding: 7px 11px;
            font-size: 12px;
          }

          .filters {
            display: grid;
            grid-template-columns: 1fr 180px 120px;
            gap: 12px;
            align-items: end;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            background: #fff;
            border-radius: 18px;
            overflow: hidden;
            box-shadow: 0 8px 24px rgba(0,0,0,0.06);
          }

          th,
          td {
            padding: 14px;
            border-bottom: 1px solid #eee;
            vertical-align: top;
            text-align: left;
            font-size: 14px;
          }

          th {
            background: #fafafa;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: #666;
          }

          .muted {
            color: #777;
            font-size: 12px;
            margin-top: 4px;
          }

          .badge {
            display: inline-block;
            padding: 6px 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 700;
            background: #eee;
          }

          .badge.pending {
            background: #fff3cd;
            color: #856404;
          }

          .badge.generated {
            background: #dbeafe;
            color: #1d4ed8;
          }

          .badge.published {
            background: #dcfce7;
            color: #166534;
          }

          .badge.error {
            background: #fee2e2;
            color: #991b1b;
          }

          .actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }

          pre {
            white-space: pre-wrap;
            background: #f8f8f8;
            padding: 10px;
            border-radius: 10px;
            font-size: 12px;
            max-width: 360px;
          }

          .nav {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-bottom: 16px;
          }

          @media (max-width: 900px) {
            .grid,
            .form-grid,
            .filters {
              grid-template-columns: 1fr;
            }

            table {
              display: block;
              overflow-x: auto;
            }

            .topbar {
              align-items: flex-start;
              flex-direction: column;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="topbar">
            <div>
              <h1>Vistora SEO Page Generator</h1>
              <div class="subtitle">Gestione keyword, generazione contenuti e pubblicazione pagine Shopify.</div>
            </div>
            <a class="btn secondary" href="/seo">Dashboard JSON</a>
          </div>

          <div class="grid">
            <div class="card">
              <div class="stat-number">${s.total}</div>
              <div class="stat-label">Totali</div>
            </div>
            <div class="card">
              <div class="stat-number">${s.pending}</div>
              <div class="stat-label">Da generare</div>
            </div>
            <div class="card">
              <div class="stat-number">${s.generated}</div>
              <div class="stat-label">Generate</div>
            </div>
            <div class="card">
              <div class="stat-number">${s.published}</div>
              <div class="stat-label">Pubblicate</div>
            </div>
            <div class="card">
              <div class="stat-number">${s.error}</div>
              <div class="stat-label">Errori</div>
            </div>
          </div>

          <div class="panel">
            <h2>Carica nuove keyword</h2>
            <form method="POST" action="/seo/keywords/import?secret=${encodeURIComponent(
              secret
            )}">
              <div class="form-grid">
                <div>
                  <label>Categoria</label>
                  <input name="category" placeholder="Es. Idee regalo" />
                </div>
                <div>
                  <label>URL target interno</label>
                  <input name="url_target" value="https://vistora.it/" />
                </div>
                <div>
                  <label>Priorità</label>
                  <select name="priority">
                    <option value="alta">Alta</option>
                    <option value="media" selected>Media</option>
                    <option value="bassa">Bassa</option>
                  </select>
                </div>
              </div>

              <label>Keyword, una per riga</label>
              <textarea name="text" placeholder="idee regalo eleganti&#10;candele profumate online&#10;prodotti gourmet online"></textarea>

              <div style="margin-top: 14px;">
                <button class="btn primary" type="submit">Importa keyword</button>
              </div>
            </form>
          </div>

          <div class="panel">
            <h2>Filtra keyword</h2>
            <form class="filters" method="GET" action="/seo/keywords">
              <input type="hidden" name="secret" value="${escapeHtml(secret)}" />

              <div>
                <label>Cerca keyword</label>
                <input name="search" value="${escapeHtml(search)}" placeholder="Cerca..." />
              </div>

              <div>
                <label>Status</label>
                <select name="status">
                  <option value="">Tutti</option>
                  <option value="pending" ${status === "pending" ? "selected" : ""}>Pending</option>
                  <option value="generated" ${status === "generated" ? "selected" : ""}>Generated</option>
                  <option value="published" ${status === "published" ? "selected" : ""}>Published</option>
                  <option value="error" ${status === "error" ? "selected" : ""}>Error</option>
                </select>
              </div>

              <div>
                <button class="btn" type="submit">Filtra</button>
              </div>
            </form>

            <div class="nav" style="margin-top:16px;">
              <a class="btn secondary" href="/seo/keywords?secret=${encodeURIComponent(secret)}">Tutte</a>
              <a class="btn secondary" href="/seo/keywords?secret=${encodeURIComponent(secret)}&status=pending">Da generare</a>
              <a class="btn secondary" href="/seo/keywords?secret=${encodeURIComponent(secret)}&status=generated">Generate</a>
              <a class="btn secondary" href="/seo/keywords?secret=${encodeURIComponent(secret)}&status=published">Pubblicate</a>
              <a class="btn secondary" href="/seo/keywords?secret=${encodeURIComponent(secret)}&status=error">Errori</a>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Keyword</th>
                <th>Status</th>
                <th>Priorità</th>
                <th>Titolo generato</th>
                <th>Pagina</th>
                <th>Azioni</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="7">Nessuna keyword trovata.</td></tr>`}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`
      <h1>Errore</h1>
      <pre>${escapeHtml(String(error))}</pre>
    `);
  }
});

/**
 * KEYWORDS JSON
 */
app.get("/seo/keywords.json", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const status = req.query.status;

  try {
    const result = status
      ? await pool.query(
          `
          SELECT * FROM seo_keywords
          WHERE status = $1
          ORDER BY id DESC
          LIMIT 300
          `,
          [status]
        )
      : await pool.query(
          `
          SELECT * FROM seo_keywords
          ORDER BY id DESC
          LIMIT 300
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
 * IMPORT DAL PANNELLO HTML
 */
app.post("/seo/keywords/import", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).send("Unauthorized");
  }

  const { text, category, url_target, priority } = req.body;
  const secret = req.query.secret || req.body.secret || "";

  if (!text) {
    return res.redirect(`/seo/keywords?secret=${encodeURIComponent(secret)}`);
  }

  const keywords = text
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean);

  for (const keyword of keywords) {
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
  }

  res.redirect(`/seo/keywords?secret=${encodeURIComponent(secret)}`);
});

/**
 * AZIONE ADMIN: GENERA
 */
app.post("/seo/admin-generate/:id", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).send("Unauthorized");
  }

  const id = req.params.id;
  const secret = req.query.secret || req.body.secret || "";

  try {
    const result = await pool.query(`SELECT * FROM seo_keywords WHERE id = $1`, [
      id
    ]);

    const row = result.rows[0];

    if (!row) {
      throw new Error("Keyword not found");
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
  }

  res.redirect(`/seo/keywords?secret=${encodeURIComponent(secret)}`);
});

/**
 * AZIONE ADMIN: PUBBLICA
 */
app.post("/seo/admin-publish/:id", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).send("Unauthorized");
  }

  const id = req.params.id;
  const secret = req.query.secret || req.body.secret || "";

  try {
    const result = await pool.query(`SELECT * FROM seo_keywords WHERE id = $1`, [
      id
    ]);

    const row = result.rows[0];

    if (!row) {
      throw new Error("Keyword not found");
    }

    if (!row.html_body) {
      throw new Error("Page not generated yet");
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
  }

  res.redirect(`/seo/keywords?secret=${encodeURIComponent(secret)}`);
});

/**
 * IMPORT DA TEXTAREA VIA API
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
      const result = await pool.query(
        `
        INSERT INTO seo_keywords 
          (keyword, category, url_target, priority, status)
        VALUES 
          ($1, $2, $3, $4, 'pending')
        ON CONFLICT (keyword) DO NOTHING
        RETURNING id
        `,
        [
          keyword,
          category || null,
          url_target || "https://vistora.it/",
          priority || "media"
        ]
      );

      if (result.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
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
 * IMPORT DA CSV VIA API
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

      const result = await pool.query(
        `
        INSERT INTO seo_keywords 
          (keyword, category, url_target, priority, status)
        VALUES 
          ($1, $2, $3, $4, 'pending')
        ON CONFLICT (keyword) DO NOTHING
        RETURNING id
        `,
        [
          keyword,
          record.category || null,
          record.url_target || "https://vistora.it/",
          record.priority || "media"
        ]
      );

      if (result.rowCount > 0) {
        inserted++;
      } else {
        skipped++;
      }
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
 * GENERA UNA PAGINA SENZA PUBBLICARE VIA API
 */
app.post("/seo/generate/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const result = await pool.query(`SELECT * FROM seo_keywords WHERE id = $1`, [
      id
    ]);

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
 * PUBBLICA UNA PAGINA GIÀ GENERATA VIA API
 */
app.post("/seo/publish/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const result = await pool.query(`SELECT * FROM seo_keywords WHERE id = $1`, [
      id
    ]);

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

/**
 * INIT DB MANUALE, ANCORA DISPONIBILE
 */
app.post("/seo/init-db", async (req, res) => {
  const secret = req.headers["x-cron-secret"];

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await initDatabase();

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

/**
 * TEST INSERT TEMPORANEO
 */
app.get("/seo/test-insert", async (req, res) => {
  try {
    await pool.query(
      `
      INSERT INTO seo_keywords 
        (keyword, category, url_target, priority, status)
      VALUES 
        ($1, $2, $3, $4, 'pending')
      ON CONFLICT (keyword) DO NOTHING
      `,
      ["idee regalo eleganti", "Idee regalo", "https://vistora.it/", "alta"]
    );

    res.json({
      ok: true,
      message: "Keyword di test inserita"
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
