import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const client = new SecretManagerServiceClient();
const cache = new Map();

export async function getSecretValue(secretName) {
  if (!secretName) {
    throw new Error("Secret name is required");
  }

  if (cache.has(secretName)) {
    return cache.get(secretName);
  }

  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error("GCP_PROJECT_ID is not configured");
  }

  const resourceName = `projects/${projectId}/secrets/${secretName}/versions/latest`;
  const [version] = await client.accessSecretVersion({ name: resourceName });
  const value = version.payload?.data?.toString("utf8");

  if (!value) {
    throw new Error(`Secret ${secretName} returned empty value`);
  }

  cache.set(secretName, value);
  return value;
}
