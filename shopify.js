function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

export async function createShopifyPage({
  title,
  handle,
  html_body
}) {
  const shop = normalizeShopDomain(process.env.SHOPIFY_SHOP);
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";

  if (!shop || !token) {
    throw new Error("Missing Shopify credentials");
  }

  if (!shop.endsWith(".myshopify.com")) {
    throw new Error(`SHOPIFY_SHOP non valido: ${shop}. Usa il dominio .myshopify.com`);
  }

  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const mutation = `
    mutation pageCreate($page: PageCreateInput!) {
      pageCreate(page: $page) {
        page {
          id
          title
          handle
          isPublished
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    page: {
      title,
      handle,
      body: html_body,
      isPublished: true
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: mutation,
      variables
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Shopify non ha restituito JSON. Endpoint: ${endpoint}. Risposta: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Shopify HTTP error ${response.status}. Endpoint: ${endpoint}. Risposta: ${text}`);
  }

  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  const errors = data?.data?.pageCreate?.userErrors || [];

  if (errors.length > 0) {
    throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`);
  }

  const page = data?.data?.pageCreate?.page;

  if (!page?.id) {
    throw new Error(`Shopify pageCreate failed: ${JSON.stringify(data)}`);
  }

  return page;
}
