export interface TagEngineClientOptions {
  /** Base URL of the privately deployed TagEngine HTTP service, e.g. http://127.0.0.1:3000 */
  baseUrl: string;
  /** Request deadline in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Injectable fetch implementation for tests and custom runtimes. */
  fetchImpl?: typeof fetch;
}

export interface TagEngineParseMetadata {
  processedCount: number;
  volumeSerial: string;
  anchorIso: string;
}

export interface TagEngineVectorRecord {
  volumeSerial: string;
  fullPath: string;
  pathHash: string;
  vector: number[];
  metadata: {
    entryType: "FILE" | "DIR" | "JUNCTION" | "SYMLINKD";
    sizeBytes: number;
    timestampIso: string;
    extension: string;
  };
  severityScore: number;
}

export interface TagEngineAlert {
  status: "ADDED" | "MODIFIED" | "DELETED";
  fullPath: string;
  pathHash: string;
  severityScore: number;
  euclideanDistance: number;
  cosineSimilarity: number;
  changedDimensions: string[];
  baseline?: TagEngineVectorRecord["metadata"];
  target?: TagEngineVectorRecord["metadata"];
}

export interface TagEngineAnalysisResult {
  mode: "SINGLE_PARSE" | "SNAPSHOT_DIFF";
  sharedAnchorIso?: string;
  baseline: TagEngineParseMetadata;
  target?: TagEngineParseMetadata;
  summary?: {
    added: number;
    modified: number;
    deleted: number;
    alertsEmitted: number;
  };
  recordsReturned?: number;
  records?: TagEngineVectorRecord[];
  alerts?: TagEngineAlert[];
}

export class TagEngineHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "TagEngineHttpError";
  }
}

/**
 * Thin Entec adapter for TagEngine's existing POST /api/analyze contract.
 * The TagEngine service must be deployed separately and reachable over a
 * trusted private network. This client never executes local shell commands.
 */
export class TagEngineClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TagEngineClientOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new Error("TagEngine baseUrl must be an absolute HTTP(S) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("TagEngine baseUrl must use HTTP or HTTPS");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("TagEngine baseUrl must not contain credentials, query, or fragment");
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("timeoutMs must be a positive finite number");
    }

    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyze(input: {
    baselineText: string;
    targetText?: string;
    minSeverity?: number;
  }): Promise<TagEngineAnalysisResult> {
    if (typeof input.baselineText !== "string" || !input.baselineText.trim()) {
      throw new Error("baselineText is required");
    }
    const minSeverity = input.minSeverity ?? 1;
    if (!Number.isFinite(minSeverity) || minSeverity < 0 || minSeverity > 10) {
      throw new Error("minSeverity must be a number between 0 and 10");
    }

    const body = JSON.stringify({
      baselineText: input.baselineText,
      targetText: input.targetText ?? "",
      minSeverity
    });
    if (new TextEncoder().encode(body).byteLength > 50 * 1024 * 1024) {
      throw new Error("TagEngine request exceeds the 50MB service limit");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body,
        signal: controller.signal
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new TagEngineHttpError(
          `TagEngine returned HTTP ${response.status}`,
          response.status,
          responseText.slice(0, 4_096)
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error("TagEngine returned invalid JSON");
      }
      if (!payload || typeof payload !== "object") {
        throw new Error("TagEngine returned an invalid response object");
      }
      const result = payload as Record<string, unknown>;
      if (result.mode !== "SINGLE_PARSE" && result.mode !== "SNAPSHOT_DIFF") {
        throw new Error("TagEngine response has an unsupported mode");
      }
      if (!result.baseline || typeof result.baseline !== "object") {
        throw new Error("TagEngine response is missing baseline metadata");
      }
      return result as unknown as TagEngineAnalysisResult;
    } catch (error) {
      if (error instanceof TagEngineHttpError || error instanceof Error && error.name !== "AbortError") {
        throw error;
      }
      throw new Error(`TagEngine request timed out after ${this.timeoutMs}ms`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
