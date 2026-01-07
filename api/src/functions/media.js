// src/functions/media.js
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} = require("@azure/storage-blob");

// Azure Functions v4 (new programming model)
const { app } = require("@azure/functions");

// ---------- helpers ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeName(name) {
  return (name || "file")
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function newId() {
  return crypto.randomUUID();
}

function parseStorageConnString(cs) {
  const parts = Object.fromEntries(
    cs
      .split(";")
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      })
  );
  return { accountName: parts.AccountName, accountKey: parts.AccountKey };
}

function makeSasUrl({ accountName, containerName, blobName, sharedKeyCredential, permissions, minutes = 15 }) {
  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(Date.now() + minutes * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    { containerName, blobName, permissions, startsOn, expiresOn },
    sharedKeyCredential
  ).toString();

  const baseUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURIComponent(blobName)}`;
  return `${baseUrl}?${sas}`;
}

function json(status, body) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// ---------- clients ----------
function getCosmosContainer() {
  const endpoint = requireEnv("COSMOS_ENDPOINT");
  const key = requireEnv("COSMOS_KEY");
  const dbName = requireEnv("COSMOS_DB");
  const containerName = requireEnv("COSMOS_CONTAINER");

  const client = new CosmosClient({ endpoint, key });
  return client.database(dbName).container(containerName);
}

function getBlobClients() {
  const storageCs = requireEnv("AzureWebJobsStorage");
  const containerName = requireEnv("MEDIA_CONTAINER");

  const blobServiceClient = BlobServiceClient.fromConnectionString(storageCs);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  const { accountName, accountKey } = parseStorageConnString(storageCs);
  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

  return { containerClient, containerName, accountName, sharedKeyCredential };
}

// ---------- HTTP API: /api/videos and /api/videos/{id} ----------
app.http("videos", {
  methods: ["GET", "POST", "PUT", "DELETE"],
  authLevel: "anonymous",
  route: "videos/{id?}",
  handler: async (request, context) => {
    try {
      const method = request.method.toUpperCase();
      const id = request.params.id || null;

      const container = getCosmosContainer();
      const { containerClient, containerName, accountName, sharedKeyCredential } = getBlobClients();
      await containerClient.createIfNotExists();

      // ---------- POST /api/videos ----------
      // Creates metadata item + returns upload SAS URL
      if (method === "POST" && !id) {
        const body = (await request.json().catch(() => ({}))) || {};
        const userId = body.userId || "demo-user";
        const videoId = newId();

        const filename = safeName(body.filename || "video.mp4");
        const blobName = `${videoId}-${filename}`;
        const contentType = body.contentType || "application/octet-stream";
        const blobUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURIComponent(blobName)}`;

        const uploadUrl = makeSasUrl({
          accountName,
          containerName,
          blobName,
          sharedKeyCredential,
          permissions: BlobSASPermissions.parse("cw") // create + write
        });

        const item = {
          id: videoId,
          userId,
          title: body.title || "Untitled",
          description: body.description || "",
          workoutType: body.workoutType || "general",
          tags: Array.isArray(body.tags) ? body.tags : [],
          contentType,
          blobName,
          blobUrl,
          status: "pending_upload",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await container.items.create(item);

        return json(201, { videoId, uploadUrl, blobUrl, item });
      }

      // ---------- GET /api/videos?userId=... ----------
      // List videos for a user + return a short-lived readUrl (SAS)
      if (method === "GET" && !id) {
        const userId = request.query.get("userId") || "demo-user";

        const q = {
          query: "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.createdAt DESC",
          parameters: [{ name: "@userId", value: userId }]
        };

        const { resources } = await container.items.query(q).fetchAll();

        const items = resources.map((v) => {
          const readUrl = makeSasUrl({
            accountName,
            containerName,
            blobName: v.blobName,
            sharedKeyCredential,
            permissions: BlobSASPermissions.parse("r"),
            minutes: 15
          });
          return { ...v, readUrl };
        });

        return json(200, { count: items.length, items });
      }

      // ---------- PUT /api/videos/{id} ----------
      // Updates metadata only
      if (method === "PUT" && id) {
        const body = (await request.json().catch(() => ({}))) || {};
        const userId = body.userId || request.query.get("userId") || "demo-user";

        const { resource } = await container.item(id, userId).read();
        if (!resource) return json(404, { error: "Not found" });

        const updated = {
          ...resource,
          title: body.title ?? resource.title,
          description: body.description ?? resource.description,
          workoutType: body.workoutType ?? resource.workoutType,
          tags: Array.isArray(body.tags) ? body.tags : resource.tags,
          status: body.status ?? resource.status,
          updatedAt: new Date().toISOString()
        };

        await container.item(id, userId).replace(updated);
        return json(200, { item: updated });
      }

      // ---------- DELETE /api/videos/{id}?userId=... ----------
      // Deletes blob + metadata
      if (method === "DELETE" && id) {
        const userId = request.query.get("userId") || "demo-user";

        const { resource } = await container.item(id, userId).read();
        if (!resource) return json(404, { error: "Not found" });

        const blobClient = containerClient.getBlobClient(resource.blobName);
        await blobClient.deleteIfExists();

        await container.item(id, userId).delete();
        return json(200, { deleted: true, id });
      }

      return json(400, { error: "Unsupported method/route" });
    } catch (err) {
      context.error(err);
      return json(500, { error: err.message || "Server error" });
    }
  }
});
