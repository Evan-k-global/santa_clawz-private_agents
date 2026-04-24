import {
  canonicalDigest,
  type DeletionRecord,
  stableJsonStringify,
  type RetentionPolicy,
  type StableJsonValue
} from "@clawz/protocol";
import { TenantKeyBroker, openBytes, sealBytes, type UnwrapRequest } from "@clawz/key-broker";

import { createManifest } from "../manifests/create-manifest.js";
import type { SealBlobInput, SealedBlobManifest, SealedBlobStore, StoredCipherEnvelope } from "../types.js";

interface ObjectListResponse {
  keys?: string[];
}

function normalizeEndpoint(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function objectUri(key: string): string {
  return `object://${key}`;
}

function objectKeyFromUri(uri: string): string {
  if (!uri.startsWith("object://")) {
    throw new Error(`Unsupported object URI: ${uri}`);
  }

  return uri.slice("object://".length);
}

export class HttpSealedBlobStore implements SealedBlobStore {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly keyBroker: TenantKeyBroker,
    private readonly bearerToken?: string
  ) {
    if (!endpoint.trim()) {
      throw new Error("CLAWZ_BLOB_STORE_ENDPOINT is required when using http-object-store mode.");
    }

    this.endpoint = normalizeEndpoint(endpoint.trim());
  }

  async ensureDirs(): Promise<void> {
    await this.request("POST", "/health", undefined, true);
  }

  private headers() {
    return {
      "content-type": "application/json",
      ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {})
    };
  }

  private async request(method: string, route: string, body?: unknown, optional = false): Promise<any> {
    const response = await fetch(`${this.endpoint}${route}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    if (!response.ok && !(optional && response.status === 404)) {
      throw new Error(`Sealed blob object-store request failed: ${method} ${route} ${response.status}`);
    }

    return response;
  }

  private async putObject(key: string, value: unknown): Promise<void> {
    await this.request("PUT", `/objects/${encodeURIComponent(key)}`, value);
  }

  private async getObject<T>(key: string): Promise<T | undefined> {
    const response = await this.request("GET", `/objects/${encodeURIComponent(key)}`, undefined, true);
    if (response.status === 404) {
      return undefined;
    }

    return (await response.json()) as T;
  }

  private async deleteObject(key: string): Promise<void> {
    await this.request("DELETE", `/objects/${encodeURIComponent(key)}`, undefined, true);
  }

  private async listObjects(prefix: string): Promise<string[]> {
    const response = await this.request("GET", `/objects?prefix=${encodeURIComponent(prefix)}`);
    const payload = (await response.json()) as ObjectListResponse;
    return Array.isArray(payload.keys) ? payload.keys : [];
  }

  private manifestKey(manifestId: string): string {
    return `manifests/${manifestId}.json`;
  }

  private deletionRecordKey(deletionId: string): string {
    return `deletions/${deletionId}.json`;
  }

  async sealJson(input: SealBlobInput): Promise<SealedBlobManifest> {
    const payload = input.payload as StableJsonValue;
    const plainText = Buffer.from(stableJsonStringify(payload), "utf8");
    const payloadDigest = canonicalDigest(payload).sha256Hex;
    const dataKey = this.keyBroker.issueDataKey(input.scope).dataKey;
    const wrappedKey = await this.keyBroker.wrapDataKey(input.scope, input.visibility, dataKey);
    const cipher = sealBytes(plainText, dataKey);
    const cipherKey = `cipher/${wrappedKey.keyId}.json`;

    await this.putObject(cipherKey, cipher);

    const manifest = createManifest(input, objectUri(cipherKey), wrappedKey.keyId, payloadDigest, plainText.byteLength);
    await this.putObject(this.manifestKey(manifest.manifestId), manifest);
    return manifest;
  }

  async readJson(manifestId: string, request: UnwrapRequest): Promise<unknown> {
    const manifest = await this.getManifest(manifestId);
    if (!manifest) {
      throw new Error(`Unknown manifest: ${manifestId}`);
    }

    const cipher = await this.getObject<StoredCipherEnvelope>(objectKeyFromUri(manifest.cipherPath));
    if (!cipher) {
      throw new Error(`Missing cipher object for manifest: ${manifestId}`);
    }

    const dataKey = await this.keyBroker.unwrapDataKey({
      ...request,
      keyId: manifest.wrappedKeyId
    });

    const plain = openBytes(cipher, dataKey).toString("utf8");
    return JSON.parse(plain) as unknown;
  }

  async listManifests(sessionId?: string): Promise<SealedBlobManifest[]> {
    const keys = await this.listObjects("manifests/");
    const manifests = (
      await Promise.all(keys.map((key) => this.getObject<SealedBlobManifest>(key)))
    )
      .filter((manifest): manifest is SealedBlobManifest => Boolean(manifest))
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));

    return sessionId ? manifests.filter((manifest) => manifest.sessionId === sessionId) : manifests;
  }

  getManifest(manifestId: string): Promise<SealedBlobManifest | undefined> {
    return this.getObject<SealedBlobManifest>(this.manifestKey(manifestId));
  }

  async expireManifest(
    manifestId: string,
    retentionPolicy: RetentionPolicy,
    deletedAtIso = new Date().toISOString()
  ): Promise<DeletionRecord | undefined> {
    const manifest = await this.getManifest(manifestId);
    if (!manifest) {
      return undefined;
    }

    if (retentionPolicy.deleteWrappedKeysOnExpiry) {
      await this.keyBroker.revokeKey(manifest.wrappedKeyId, deletedAtIso);
    }

    await this.deleteObject(objectKeyFromUri(manifest.cipherPath));
    await this.deleteObject(this.manifestKey(manifestId));

    const deletionRecord: DeletionRecord = {
      deletionId: `deletion_${manifest.manifestId}`,
      artifactId: manifest.manifestId,
      retentionPolicyId: retentionPolicy.policyId,
      scheduledForIso: deletedAtIso,
      deletedAtIso,
      revokedKeyIds: retentionPolicy.deleteWrappedKeysOnExpiry ? [manifest.wrappedKeyId] : []
    };

    await this.putObject(this.deletionRecordKey(deletionRecord.deletionId), deletionRecord);
    return deletionRecord;
  }

  async listDeletionRecords(): Promise<DeletionRecord[]> {
    const keys = await this.listObjects("deletions/");
    return (await Promise.all(keys.map((key) => this.getObject<DeletionRecord>(key)))).filter(
      (record): record is DeletionRecord => Boolean(record)
    );
  }
}
