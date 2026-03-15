import {
  S3Client as AwsS3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { ObsidianHttpHandler } from "./handler";

export interface S3Config {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  prefix: string;
}

export interface S3Object {
  key: string;
  lastModified: Date;
  size: number;
  etag: string;
}

export class S3Client {
  private client: AwsS3Client;

  constructor(private config: S3Config) {
    this.client = new AwsS3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
      requestHandler: new ObsidianHttpHandler(),
    });
  }

  private prefixedKey(key: string): string {
    if (!this.config.prefix) return key;
    return this.config.prefix.replace(/\/+$/, "") + "/" + key;
  }

  private unprefixedKey(key: string): string {
    if (!this.config.prefix) return key;
    const prefix = this.config.prefix.replace(/\/+$/, "") + "/";
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  async listObjects(continuationToken?: string): Promise<{
    objects: S3Object[];
    isTruncated: boolean;
    nextToken?: string;
  }> {
    const prefix = this.config.prefix
      ? this.config.prefix.replace(/\/+$/, "") + "/"
      : undefined;

    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        MaxKeys: 1000,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects: S3Object[] = (result.Contents || [])
      .filter((obj) => obj.Key)
      .map((obj) => {
        const key = this.unprefixedKey(obj.Key!);
        return { key, lastModified: obj.LastModified || new Date(), size: obj.Size || 0, etag: (obj.ETag || "").replace(/"/g, "") };
      })
      .filter((obj) => obj.key && !obj.key.endsWith("/"));

    return {
      objects,
      isTruncated: result.IsTruncated || false,
      nextToken: result.NextContinuationToken,
    };
  }

  async listAllObjects(): Promise<S3Object[]> {
    const allObjects: S3Object[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.listObjects(continuationToken);
      allObjects.push(...result.objects);
      continuationToken = result.isTruncated ? result.nextToken : undefined;
    } while (continuationToken);

    return allObjects;
  }

  async getObject(key: string): Promise<ArrayBuffer> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.prefixedKey(key),
      })
    );

    const body = result.Body;
    if (!body) throw new Error(`Empty response for ${key}`);

    if ("transformToByteArray" in body && typeof body.transformToByteArray === "function") {
      const bytes = await body.transformToByteArray();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }

    if (body instanceof Blob) {
      return await body.arrayBuffer();
    }

    if (body instanceof Uint8Array) {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    }

    throw new Error(`Unexpected body type for ${key}`);
  }

  async putObject(
    key: string,
    data: ArrayBuffer,
    metadata?: Record<string, string>
  ): Promise<string> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.prefixedKey(key),
        Body: new Uint8Array(data),
        ContentType: "application/octet-stream",
        Metadata: metadata,
      })
    );
    return (result.ETag || "").replace(/"/g, "");
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.prefixedKey(key),
      })
    );
  }

  async headObject(key: string): Promise<{
    lastModified: Date;
    size: number;
    etag: string;
    metadata: Record<string, string>;
  } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: this.prefixedKey(key),
        })
      );
      return {
        lastModified: result.LastModified || new Date(),
        size: result.ContentLength || 0,
        etag: (result.ETag || "").replace(/"/g, ""),
        metadata: result.Metadata || {},
      };
    } catch (e: unknown) {
      const err = e as { $metadata?: { httpStatusCode?: number } };
      if (err.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.listObjects();
      return { ok: true };
    } catch (e) {
      console.error("OVH Sync: test connection failed:", e);
      let error = "Unknown error";
      const err = e as { $metadata?: { httpStatusCode?: number }; message?: string };
      const status = err.$metadata?.httpStatusCode;
      if (status === 403) {
        error = "Access denied (403). Check your access key, secret key, and bucket permissions.";
      } else if (status === 404) {
        error = "Bucket not found (404). Check the bucket name.";
      } else if (status === 301) {
        error = "Redirect (301). The bucket may be in a different region.";
      } else if (e instanceof Error) {
        error = e.message;
      }
      return { ok: false, error };
    }
  }
}
