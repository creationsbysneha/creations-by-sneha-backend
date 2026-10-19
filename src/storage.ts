import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { assertStorageKey } from "./keys.js";
import { logAt, logDebug, logError, logInfo, logWarn, safeError } from "./logger.js";

export type BucketKind = "private" | "public";

export type PutOptions = {
  contentType: string;
  cacheControl: string;
};

export type StoredObject = {
  key: string;
  size: number;
  lastModified: Date;
};

export type ListPage = {
  objects: StoredObject[];
  cursor?: string;
};

export interface Bucket {
  readonly kind: BucketKind;
  put(key: string, body: Buffer, options: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string, cursor?: string): Promise<ListPage>;
}

export interface ObjectStorage {
  readonly driver: "r2" | "local" | "memory";
  readonly private: Bucket;
  readonly public: Bucket;
  publicUrl(key: string): string;
}

export class StorageError extends Error {
  statusCode?: number;
  attempts?: number;
  code?: string;
  constructor(message: string, extras?: { statusCode?: number; attempts?: number; code?: string }) {
    super(message);
    this.name = "StorageError";
    if (extras) Object.assign(this, extras);
  }
}

const LIST_PREFIXES = new Set(["media/", "published/"]);

function checkListPrefix(prefix: string) {
  if (!LIST_PREFIXES.has(prefix)) throw new StorageError("Listing is limited to the media/ and published/ prefixes.");
}

function trimBase(url: string) {
  return url.replace(/\/+$/, "");
}

const R2_VARIABLES = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PRIVATE_BUCKET_NAME",
  "R2_PUBLIC_BASE_URL",
] as const;

export function r2Settings(env: NodeJS.ProcessEnv = process.env) {
  const missing: string[] = R2_VARIABLES.filter((name) => !env[name]);
  if (!env.BUCKET_ENDPOINT && !env.CLOUDFLARE_ACCOUNT_ID) missing.push("BUCKET_ENDPOINT or CLOUDFLARE_ACCOUNT_ID");
  if (missing.length) throw new StorageError(`R2 storage is selected, but these variables are missing: ${missing.join(", ")}`);

  let endpoint: URL;
  try {
    endpoint = new URL(env.BUCKET_ENDPOINT || `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  } catch {
    throw new StorageError("BUCKET_ENDPOINT is not a valid URL.");
  }
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".r2.cloudflarestorage.com")) {
    throw new StorageError("BUCKET_ENDPOINT must be an https://<account>.r2.cloudflarestorage.com address.");
  }

  let publicBase: URL;
  try {
    publicBase = new URL(env.R2_PUBLIC_BASE_URL || "");
  } catch {
    throw new StorageError("R2_PUBLIC_BASE_URL is not a valid URL.");
  }
  if (publicBase.protocol !== "https:") throw new StorageError("R2_PUBLIC_BASE_URL must use https.");
  if (env.R2_BUCKET_NAME === env.R2_PRIVATE_BUCKET_NAME) {
    throw new StorageError("R2_BUCKET_NAME and R2_PRIVATE_BUCKET_NAME must be different buckets.");
  }

  return {
    endpoint: endpoint.origin,
    accessKeyId: env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY || "",
    publicBucket: env.R2_BUCKET_NAME || "",
    privateBucket: env.R2_PRIVATE_BUCKET_NAME || "",
    publicBaseUrl: trimBase(publicBase.toString()),
  };
}

function statusOf(error: unknown) {
  const meta = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode;
}

function nameOf(error: unknown) {
  return (error as { name?: string }).name || "";
}

function wrap(kind: BucketKind, action: string, error: unknown): never {
  const status = statusOf(error);
  const name = nameOf(error);
  const attempts = (error as { $metadata?: { attempts?: number } }).$metadata?.attempts;
  throw new StorageError(`R2 ${kind} bucket ${action} failed${status ? ` (${status}${name ? ` ${name}` : ""})` : name ? ` (${name})` : ""}.`, {
    statusCode: status,
    attempts,
    code: name,
  });
}

function r2Bucket(client: S3Client, bucket: string, kind: BucketKind): Bucket {
  return {
    kind,
    async put(key, body, options) {
      assertStorageKey(kind, key);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: options.contentType,
            CacheControl: options.cacheControl,
          }),
        );
      } catch (error) {
        wrap(kind, "upload", error);
      }
    },
    async get(key) {
      assertStorageKey(kind, key);
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await result.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (error) {
        if (statusOf(error) === 404 || nameOf(error) === "NoSuchKey") return null;
        wrap(kind, "read", error);
      }
    },
    async exists(key) {
      assertStorageKey(kind, key);
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (statusOf(error) === 404 || nameOf(error) === "NotFound") return false;
        wrap(kind, "check", error);
      }
    },
    async delete(key) {
      assertStorageKey(kind, key);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        wrap(kind, "delete", error);
      }
    },
    async list(prefix, cursor) {
      checkListPrefix(prefix);
      try {
        const result = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: cursor, MaxKeys: 500 }),
        );
        return {
          objects: (result.Contents || []).flatMap((item) =>
            item.Key ? [{ key: item.Key, size: item.Size || 0, lastModified: item.LastModified || new Date(0) }] : [],
          ),
          cursor: result.IsTruncated ? result.NextContinuationToken : undefined,
        };
      } catch (error) {
        wrap(kind, "list", error);
      }
    },
  };
}

export function createR2Storage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const settings = r2Settings(env);
  const client = new S3Client({
    region: "auto",
    endpoint: settings.endpoint,
    forcePathStyle: true,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
  return {
    driver: "r2",
    private: r2Bucket(client, settings.privateBucket, "private"),
    public: r2Bucket(client, settings.publicBucket, "public"),
    publicUrl: (key) => `${settings.publicBaseUrl}/${key}`,
  };
}

function localBucket(root: string, kind: BucketKind): Bucket {
  const base = path.resolve(root, kind);

  const resolveKey = (key: string) => {
    assertStorageKey(kind, key);
    const full = path.resolve(base, key);
    if (!full.startsWith(`${base}${path.sep}`)) throw new StorageError("Invalid storage key");
    return full;
  };

  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
      entries.map((entry) => {
        const full = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(full) : Promise.resolve([full]);
      }),
    );
    return nested.flat();
  };

  return {
    kind,
    async put(key, body) {
      const full = resolveKey(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
    },
    async get(key) {
      try {
        return await readFile(resolveKey(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async exists(key) {
      try {
        await stat(resolveKey(key));
        return true;
      } catch {
        return false;
      }
    },
    async delete(key) {
      await rm(resolveKey(key), { force: true });
    },
    async list(prefix) {
      checkListPrefix(prefix);
      const files = await walk(path.join(base, prefix));
      const objects = await Promise.all(
        files.map(async (file) => {
          const info = await stat(file);
          return { key: path.relative(base, file).split(path.sep).join("/"), size: info.size, lastModified: info.mtime };
        }),
      );
      return { objects };
    },
  };
}

export function createLocalStorage(directory: string, publicBaseUrl: string): ObjectStorage {
  return {
    driver: "local",
    private: localBucket(directory, "private"),
    public: localBucket(directory, "public"),
    publicUrl: (key) => `${trimBase(publicBaseUrl)}/${key}`,
  };
}

type MemoryEntry = { body: Buffer; options: PutOptions; lastModified: Date };
type Operation = "put" | "get" | "exists" | "delete" | "list";

export type MemoryStorage = ObjectStorage & {
  objects: Record<BucketKind, Map<string, MemoryEntry>>;
  failNext(kind: BucketKind, operation: Operation, key?: string): void;
  calls: Array<{ kind: BucketKind; operation: Operation; key: string }>;
};

export function createMemoryStorage(publicBaseUrl = "https://assets.example.test"): MemoryStorage {
  const objects: Record<BucketKind, Map<string, MemoryEntry>> = { private: new Map(), public: new Map() };
  const failures: Array<{ kind: BucketKind; operation: Operation; key?: string }> = [];
  const calls: MemoryStorage["calls"] = [];

  const maybeFail = (kind: BucketKind, operation: Operation, key: string) => {
    calls.push({ kind, operation, key });
    const index = failures.findIndex((item) => item.kind === kind && item.operation === operation && (!item.key || item.key === key));
    if (index >= 0) {
      failures.splice(index, 1);
      throw new StorageError(`R2 ${kind} bucket ${operation} failed (simulated).`);
    }
  };

  const bucket = (kind: BucketKind): Bucket => ({
    kind,
    async put(key, body, options) {
      assertStorageKey(kind, key);
      maybeFail(kind, "put", key);
      objects[kind].set(key, { body: Buffer.from(body), options, lastModified: new Date() });
    },
    async get(key) {
      assertStorageKey(kind, key);
      maybeFail(kind, "get", key);
      return objects[kind].get(key)?.body || null;
    },
    async exists(key) {
      assertStorageKey(kind, key);
      maybeFail(kind, "exists", key);
      return objects[kind].has(key);
    },
    async delete(key) {
      assertStorageKey(kind, key);
      maybeFail(kind, "delete", key);
      objects[kind].delete(key);
    },
    async list(prefix) {
      checkListPrefix(prefix);
      maybeFail(kind, "list", prefix);
      return {
        objects: [...objects[kind].entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, entry]) => ({ key, size: entry.body.length, lastModified: entry.lastModified })),
      };
    },
  });

  return {
    driver: "memory",
    private: bucket("private"),
    public: bucket("public"),
    publicUrl: (key) => `${trimBase(publicBaseUrl)}/${key}`,
    objects,
    calls,
    failNext(kind, operation, key) {
      failures.push({ kind, operation, key });
    },
  };
}

function r2Message(operation: string, key: string, result: unknown) {
  if (operation === "put") return key.startsWith("published/") ? "snapshot_uploaded" : "uploaded";
  if (operation === "get") return result ? "downloaded" : "missing";
  if (operation === "exists") return result ? "exists" : "not_found";
  if (operation === "delete") return "deleted";
  if (operation === "list") return "listed";
  return operation;
}

function r2Level(operation: string, _key: string, result: unknown): "debug" | "info" | "warn" {
  if (operation === "get" && !result) return "warn";
  if (operation === "put" || operation === "delete") return "info";
  return "debug";
}

export function instrumentBucket(bucket: Bucket): Bucket {
  const run = async <T>(operation: string, key: string, extra: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
    if (!config.logging.r2Operations) return fn();
    const started = Date.now();
    if (operation === "put") logDebug("R2", "upload_start", { bucket: bucket.kind, key, ...extra });
    try {
      const result = await fn();
      logAt(r2Level(operation, key, result), "R2", r2Message(operation, key, result), {
        bucket: bucket.kind,
        key,
        operation,
        durationMs: Date.now() - started,
        ...extra,
      });
      return result;
    } catch (error) {
      const details = safeError(error);
      if (typeof details.attempts === "number" && details.attempts > 1) {
        logWarn("R2", "retry", { bucket: bucket.kind, key, operation, attempts: details.attempts });
      }
      logError("R2", `${operation}_failed`, {
        bucket: bucket.kind,
        key,
        operation,
        durationMs: Date.now() - started,
        ...details,
        ...extra,
      });
      throw error;
    }
  };

  return {
    kind: bucket.kind,
    put: (key, body, options) => run("put", key, { contentType: options.contentType, bytes: body.length }, () => bucket.put(key, body, options)),
    get: (key) => run("get", key, {}, () => bucket.get(key)),
    exists: (key) => run("exists", key, {}, () => bucket.exists(key)),
    delete: (key) => run("delete", key, {}, () => bucket.delete(key)),
    list: (prefix, cursor) => run("list", prefix, {}, () => bucket.list(prefix, cursor)),
  };
}

export function instrumentStorage<T extends ObjectStorage>(storage: T): T {
  return { ...storage, private: instrumentBucket(storage.private), public: instrumentBucket(storage.public) };
}

export function createStorage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const driver = env.STORAGE_DRIVER || "local";
  try {
    if (driver === "r2") {
      const storage = instrumentStorage(createR2Storage(env));
      logInfo("R2", "configured", { driver: "r2" });
      return storage;
    }
    if (driver === "local") {
      const api = trimBase(env.API_PUBLIC_URL || `http://localhost:${env.PORT || 4000}`);
      return instrumentStorage(createLocalStorage(env.STORAGE_DIR || "storage", `${api}/dev-public`));
    }
    throw new StorageError(`STORAGE_DRIVER must be "r2" or "local".`);
  } catch (error) {
    if (driver === "r2") logError("R2", "configuration_failed", safeError(error));
    throw error;
  }
}
