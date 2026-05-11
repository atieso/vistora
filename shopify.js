function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function getShopifyConfig() {
  const shop = normalizeShopDomain(process.env.SHOPIFY_SHOP);
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";

  if (!shop || !token) {
    throw new Error("Missing Shopify credentials");
  }

  if (!shop.endsWith(".myshopify.com")) {
    throw new Error(`SHOPIFY_SHOP non valido: ${shop}. Usa il dominio .myshopify.com`);
  }

  return {
    shop,
    token,
    apiVersion,
    endpoint: `https://${shop}/admin/api/${apiVersion}/graphql.json`
  };
}

async function shopifyGraphql(query, variables = {}) {
  const { endpoint, token } = getShopifyConfig();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Shopify non ha restituito JSON. Risposta: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Shopify HTTP error ${response.status}: ${text}`);
  }

  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

export async function createShopifyPage({
  title,
  handle,
  html_body
}) {
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

  const data = await shopifyGraphql(mutation, variables);

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

/**
 * Cerca automaticamente il miglior link interno Shopify
 * tra collezioni, pagine e prodotti.
 */
export async function findBestInternalLink(keyword) {
  const publicDomain = process.env.PUBLIC_STORE_URL || "https://vistora.it";

  const query = `
    query internalLinks {
      collections(first: 100) {
        nodes {
          title
          handle
        }
      }
      pages(first: 100) {
        nodes {
          title
          handle
        }
      }
      products(first: 100, query: "status:active") {
        nodes {
          title
          handle
        }
      }
    }
  `;

  const data = await shopifyGraphql(query);

  const collections = data?.data?.collections?.nodes || [];
  const pages = data?.data?.pages?.nodes || [];
  const products = data?.data?.products?.nodes || [];

  const candidates = [
    ...collections.map((item) => ({
      type: "collection",
      title: item.title,
      handle: item.handle,
      url: `${publicDomain}/collections/${item.handle}`
    })),
    ...pages.map((item) => ({
      type: "page",
      title: item.title,
      handle: item.handle,
      url: `${publicDomain}/pages/${item.handle}`
    })),
    ...products.map((item) => ({
      type: "product",
      title: item.title,
      handle: item.handle,
      url: `${publicDomain}/products/${item.handle}`
    }))
  ];

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreInternalLink(keyword, candidate)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score <= 0) {
    return {
      type: "home",
      title: "Vistora",
      handle: "",
      url: publicDomain,
      score: 0
    };
  }

  return best;
}

function scoreInternalLink(keyword, candidate) {
  const keywordText = normalizeText(keyword);
  const titleText = normalizeText(candidate.title);
  const handleText = normalizeText(candidate.handle);

  const keywordTokens = keywordText
    .split(" ")
    .filter((word) => word.length > 2);

  let score = 0;

  for (const token of keywordTokens) {
    if (titleText.includes(token)) score += 4;
    if (handleText.includes(token)) score += 3;
  }

  if (titleText === keywordText) score += 20;
  if (handleText === keywordText.replaceAll(" ", "-")) score += 15;

  if (candidate.type === "collection") score += 3;
  if (candidate.type === "page") score += 2;
  if (candidate.type === "product") score += 1;

  return score;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
