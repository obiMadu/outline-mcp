import fs from "node:fs/promises";

const DEFAULT_BASE_URL = "https://app.getoutline.com";
const OUTPUT_PATH = "evaluation.xml";

const normalizeBaseUrl = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("OUTLINE_BASE_URL is empty");
  }
  const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
};

const callOutline = async (baseUrl, apiKey, method, payload = {}) => {
  const url = new URL(method, `${baseUrl}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const errorMessage =
      typeof body === "object" && body && "error" in body
        ? body.error
        : `Request failed with status ${response.status}`;
    throw new Error(`Outline API error: ${errorMessage}`);
  }

  return body;
};

const requireValue = (value, message) => {
  if (!value) {
    throw new Error(message);
  }
  return value;
};

const getEmailDomain = (email) => {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1] : "";
};

const toXml = (qaPairs) => {
  const lines = ["<evaluation>"];
  for (const pair of qaPairs) {
    lines.push("  <qa_pair>");
    lines.push(`    <question>${pair.question}</question>`);
    lines.push(`    <answer>${pair.answer}</answer>`);
    lines.push("  </qa_pair>");
  }
  lines.push("</evaluation>");
  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const apiKey = process.env.OUTLINE_API_KEY;
  const baseUrlEnv = process.env.OUTLINE_BASE_URL ?? DEFAULT_BASE_URL;
  const baseUrl = normalizeBaseUrl(baseUrlEnv);

  requireValue(apiKey, "OUTLINE_API_KEY is required");

  const auth = await callOutline(baseUrl, apiKey, "auth.info");
  const team = requireValue(auth.data?.team, "Auth response missing team");
  const user = requireValue(auth.data?.user, "Auth response missing user");

  const collectionsResponse = await callOutline(
    baseUrl,
    apiKey,
    "collections.list",
    { limit: 50, offset: 0, sort: "name", direction: "ASC" }
  );
  const collections = requireValue(
    collectionsResponse.data,
    "collections.list returned no data"
  );
  requireValue(collections.length, "No collections available");

  const firstCollection = collections[0];
  const primaryCollectionId = team.defaultCollectionId ?? firstCollection.id;
  const primaryCollectionLabel = team.defaultCollectionId
    ? "default collection"
    : "first collection sorted by name ASC";

  const primaryCollectionResponse = await callOutline(
    baseUrl,
    apiKey,
    "collections.info",
    { id: primaryCollectionId }
  );
  const primaryCollection = requireValue(
    primaryCollectionResponse.data,
    "Primary collection not found"
  );
  const firstCollectionInfoResponse = await callOutline(
    baseUrl,
    apiKey,
    "collections.info",
    { id: firstCollection.id }
  );
  const firstCollectionInfo = requireValue(
    firstCollectionInfoResponse.data,
    "First collection info missing"
  );

  const authUserInfoResponse = await callOutline(
    baseUrl,
    apiKey,
    "users.info",
    { id: user.id }
  );
  const authUserInfo = requireValue(
    authUserInfoResponse.data,
    "Authenticated user not found"
  );

  const documentsOverallResponse = await callOutline(
    baseUrl,
    apiKey,
    "documents.list",
    { limit: 1, offset: 0, sort: "updatedAt", direction: "DESC" }
  );
  const documentsOverall = requireValue(
    documentsOverallResponse.data,
    "documents.list returned no data"
  );
  requireValue(documentsOverall.length, "No documents available");

  const latestDocument = documentsOverall[0];
  const latestDocumentInfoResponse = await callOutline(
    baseUrl,
    apiKey,
    "documents.info",
    { id: latestDocument.id }
  );
  const latestDocumentInfo = requireValue(
    latestDocumentInfoResponse.data,
    "Latest document info missing"
  );

  const latestDocumentCollectionResponse = await callOutline(
    baseUrl,
    apiKey,
    "collections.info",
    { id: latestDocument.collectionId }
  );
  const latestDocumentCollection = requireValue(
    latestDocumentCollectionResponse.data,
    "Latest document collection info missing"
  );

  const primaryCollectionLatestResponse = await callOutline(
    baseUrl,
    apiKey,
    "documents.list",
    {
      collectionId: primaryCollectionId,
      limit: 1,
      offset: 0,
      sort: "updatedAt",
      direction: "DESC"
    }
  );
  const primaryCollectionLatest = requireValue(
    primaryCollectionLatestResponse.data,
    "Primary collection documents missing"
  );
  requireValue(primaryCollectionLatest.length, "Primary collection has no documents");

  const primaryCollectionOldestResponse = await callOutline(
    baseUrl,
    apiKey,
    "documents.list",
    {
      collectionId: primaryCollectionId,
      limit: 1,
      offset: 0,
      sort: "updatedAt",
      direction: "ASC"
    }
  );
  const primaryCollectionOldest = requireValue(
    primaryCollectionOldestResponse.data,
    "Primary collection oldest document missing"
  );
  requireValue(primaryCollectionOldest.length, "Primary collection has no documents");

  const userCache = new Map();
  const loadUser = async (userRef, label) => {
    const userId = requireValue(userRef?.id, `${label} id missing`);
    if (userCache.has(userId)) {
      return userCache.get(userId);
    }
    const userResponse = await callOutline(baseUrl, apiKey, "users.info", {
      id: userId
    });
    const userInfo = requireValue(userResponse.data, `${label} info missing`);
    userCache.set(userId, userInfo);
    return userInfo;
  };

  const creatorUser = await loadUser(latestDocumentInfo.createdBy, "Creator");
  const updaterUser = await loadUser(latestDocumentInfo.updatedBy, "Updater");
  const creatorEmail = requireValue(creatorUser.email, "Creator email missing");
  const updaterName = requireValue(updaterUser.name, "Updater name missing");

  const qaPairs = [
    {
      question: `What is the name of the ${primaryCollectionLabel} for this workspace?`,
      answer: primaryCollection.name
    },
    {
      question:
        "What is the workspace name and how many collections are returned by collections.list with limit 50? Answer as <name> | collections=<count>.",
      answer: `${team.name} | collections=${collections.length}`
    },
    {
      question:
        "What role is assigned to the authenticated user?",
      answer: authUserInfo.role
    },
    {
      question:
        "What is the email domain of the authenticated user?",
      answer: getEmailDomain(authUserInfo.email)
    },
    {
      question:
        "What is the title of the most recently updated document overall and its collection name? Answer as <title> | <collection>.",
      answer: `${latestDocument.title} | ${latestDocumentCollection.name}`
    },
    {
      question:
        "What is the creator email for the most recently updated document overall?",
      answer: creatorEmail
    },
    {
      question:
        "What is the name of the user who last updated the most recently updated document overall?",
      answer: updaterName
    },
    {
      question: `What is the title of the most recently updated document in the ${primaryCollectionLabel}?`,
      answer: primaryCollectionLatest[0].title
    },
    {
      question: `What is the title of the oldest updated document in the ${primaryCollectionLabel}?`,
      answer: primaryCollectionOldest[0].title
    },
    {
      question:
        "For the first collection sorted by name ASC, is sharing enabled? Answer true or false.",
      answer: String(Boolean(firstCollectionInfo.sharing))
    }
  ];

  const xml = toXml(qaPairs);
  await fs.writeFile(OUTPUT_PATH, xml, "utf8");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
