import { requestUrl } from "obsidian";
import type { HttpHandlerOptions } from "@smithy/types";

// Use inline types to avoid version mismatches with @smithy/protocol-http
interface HttpRequest {
  method: string;
  protocol: string;
  hostname: string;
  port?: number;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Custom HTTP handler that uses Obsidian's requestUrl() instead of fetch().
 * This bypasses CORS restrictions and works on both desktop and mobile.
 */
export class ObsidianHttpHandler {
  async handle(
    request: HttpRequest,
    _options?: HttpHandlerOptions
  ): Promise<{ response: HttpResponse }> {
    const url = this.buildUrl(request);

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      // host is derived from the URL; content-length is set by requestUrl
      // from the body — passing it explicitly can conflict with Electron's
      // net module and cause ERR_ILLEGAL_ARGUMENT.
      if (lower === "host" || lower === "content-length") continue;
      headers[key] = String(value);
    }

    let body: string | ArrayBuffer | undefined;
    if (request.body) {
      if (request.body instanceof Uint8Array) {
        // Create a clean ArrayBuffer copy — passing .buffer.slice() can
        // produce detached or shared buffers that Electron rejects.
        const copy = new ArrayBuffer(request.body.byteLength);
        new Uint8Array(copy).set(request.body);
        body = copy;
      } else if (typeof request.body === "string") {
        body = request.body;
      } else if (request.body instanceof ArrayBuffer) {
        body = request.body;
      }
    }

    const response = await requestUrl({
      url,
      method: request.method,
      headers,
      body,
      throw: false,
    });

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      responseHeaders[key.toLowerCase()] = typeof value === "string" ? value : String(value);
    }

    // Wrap in a ReadableStream so the AWS SDK's collectBody/sdStream
    // deserialization works on both desktop and mobile.  Blob works on
    // desktop but mobile Obsidian's runtime rejects it ("unsupported type").
    const bytes = new Uint8Array(response.arrayBuffer);
    const responseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    return {
      response: {
        statusCode: response.status,
        headers: responseHeaders,
        body: responseBody,
      },
    };
  }

  updateHttpClientConfig(): void {}
  httpHandlerConfigs(): Record<string, never> {
    return {};
  }

  private buildUrl(request: HttpRequest): string {
    const protocol = request.protocol || "https:";
    let path = request.path;
    if (request.query) {
      const queryParts: string[] = [];
      for (const [key, value] of Object.entries(request.query)) {
        if (value != null) {
          queryParts.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
          );
        }
      }
      if (queryParts.length > 0) {
        path += `?${queryParts.join("&")}`;
      }
    }
    return `${protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${path}`;
  }
}
