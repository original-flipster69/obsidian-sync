import { requestUrl } from "obsidian";
import type { HttpHandlerOptions } from "@smithy/types";

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

export class ObsidianHttpHandler {
  async handle(
    request: HttpRequest,
    _options?: HttpHandlerOptions
  ): Promise<{ response: HttpResponse }> {
    const url = this.buildUrl(request);

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "content-length") continue;
      headers[key] = String(value);
    }

    let body: string | ArrayBuffer | undefined;
    if (request.body) {
      if (request.body instanceof Uint8Array) {
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
