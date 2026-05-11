export async function createShopifyPage({
  title,
  handle,
  html_body,
  meta_title,
  meta_description
}) {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";

  if (!shop || !token) {
    throw new Error("Missing Shopify credentials");
  }

  const endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  const mutation = `
    mutation pageCreate($page: PageCreateInput!) {
      pageCreate(page: $page) {
        page {
          id
          title
          handle
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
      isPublished: true,
      seo: {
        title: meta_title,
        description: meta_description
      }
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

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify HTTP error: ${JSON.stringify(data)}`);
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
