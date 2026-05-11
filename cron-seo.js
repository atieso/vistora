import "dotenv/config";
import { pool } from "./db.js";
import { generateSeoPage } from "./openai-seo.js";
import { createShopifyPage } from "./shopify.js";

async function runCron() {
  const limit = Number(process.env.DAILY_LIMIT || 5);

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

  console.log(`Trovate ${result.rows.length} keyword da processare`);

  for (const row of result.rows) {
    try {
      console.log(`Genero pagina per: ${row.keyword}`);

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

      console.log(`Pubblicata: ${publishedUrl}`);
    } catch (error) {
      console.error(`Errore su keyword ${row.keyword}:`, error);

      await pool.query(
        `
        UPDATE seo_keywords
        SET status = 'error',
            error_message = $1
        WHERE id = $2
        `,
        [String(error), row.id]
      );
    }
  }

  await pool.end();
}

runCron()
  .then(() => {
    console.log("Cron SEO completato");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Errore cron SEO:", error);
    process.exit(1);
  });
