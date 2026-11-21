export interface TagEngineClientOptions {
  /** Base URL of the privately deployed TagEngine HTTP service, e.g. http://127.0.0.1:3000 */
  baseUrl: string;
  /** Bearer token for TagEngine's protected API. Keep server-side; never expose in browser code. */
  apiToken?: string;
  /** Request deadline in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Injectable fetch implementation for tests and custom runtimes. */
  fetchImpl?: typeof fetch;
}


export interface TagEngineStoredSnapshot {
  id: string;
  volumeId: string;
  label: string;
  createdAt: string;
  processedCount: number;
  volumeSerial: string;
  anchorIso: string;
}

export interface TagEngineStoredComparison {
  id: string;
  volumeId: string;
  baselineId: string;
  targetId: string;
  createdAt: string;
  minSeverity: number;
  sharedAnchorIso: string;
  summary: { added: number; modified: number; deleted: number; alertsEmitted: number };
  alerts?: TagEngineAlert[];
}

export interface TagEngineRetentionResult {
  dryRun: boolean;
  cutoff: string;
  candidates: { snapshots: number; comparisons: number };
  deleted: { snapshots: number; comparisons: number };
  bytesReclaimable: number;
  remainingUsage: { files: number; bytes: number };
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
  private readonly apiToken?: string;
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
    if (options.apiToken !== undefined && !options.apiToken.trim()) {
      throw new Error("apiToken must be a non-empty string when provided");
    }
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "accept": "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(this.apiToken ? { "authorization": "Bearer " + this.apiToken } : {}),
          ...init.headers
        },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new TagEngineHttpError(`TagEngine returned HTTP ${response.status}`, response.status, text.slice(0, 4096));
      }
      try { return JSON.parse(text); } catch { throw new Error("TagEngine returned invalid JSON"); }
    } catch (error) {
      if (error instanceof TagEngineHttpError || error instanceof Error && error.name !== "AbortError") throw error;
      throw new Error(`TagEngine request timed out after ${this.timeoutMs}ms`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async createSnapshot(input: { snapshotText: string; volumeId?: string; label?: string }): Promise<TagEngineStoredSnapshot> {
    if (typeof input.snapshotText !== "string" || !input.snapshotText.trim()) throw new Error("snapshotText is required");
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).byteLength > 50 * 1024 * 1024) throw new Error("TagEngine request exceeds the 50MB service limit");
    const payload = await this.requestJson("/api/snapshots", { method: "POST", body });
    const snapshot = (payload as { snapshot?: unknown })?.snapshot;
    if (!snapshot || typeof snapshot !== "object" || typeof (snapshot as TagEngineStoredSnapshot).id !== "string") {
      throw new Error("TagEngine returned invalid snapshot metadata");
    }
    return snapshot as TagEngineStoredSnapshot;
  }

  async listSnapshots(input: { volumeId?: string; limit?: number } = {}): Promise<TagEngineStoredSnapshot[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500");
    const query = new URLSearchParams({ limit: String(limit) });
    if (input.volumeId) query.set("volumeId", input.volumeId);
    const payload = await this.requestJson("/api/snapshots?" + query.toString());
    const snapshots = (payload as { snapshots?: unknown })?.snapshots;
    if (!Array.isArray(snapshots)) throw new Error("TagEngine returned invalid snapshot list");
    return snapshots as TagEngineStoredSnapshot[];
  }

  async getSnapshot(id: string): Promise<TagEngineStoredSnapshot> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("snapshot id must be a UUID");
    const payload = await this.requestJson("/api/snapshots/" + encodeURIComponent(id));
    const snapshot = (payload as { snapshot?: unknown })?.snapshot;
    if (!snapshot || typeof snapshot !== "object") throw new Error("TagEngine returned invalid snapshot metadata");
    return snapshot as TagEngineStoredSnapshot;
  }

  async compareSnapshots(input: { baselineId: string; targetId: string; minSeverity?: number }): Promise<TagEngineStoredComparison> {
    if (!/^[0-9a-f-]{36}$/i.test(input.baselineId) || !/^[0-9a-f-]{36}$/i.test(input.targetId)) {
      throw new Error("baselineId and targetId must be UUIDs");
    }
    if (input.baselineId === input.targetId) throw new Error("baselineId and targetId must be different");
    const minSeverity = input.minSeverity ?? 1;
    if (!Number.isFinite(minSeverity) || minSeverity < 0 || minSeverity > 10) {
      throw new Error("minSeverity must be a number between 0 and 10");
    }
    const payload = await this.requestJson("/api/snapshot-comparisons", {
      method: "POST", body: JSON.stringify({ ...input, minSeverity })
    });
    const comparison = (payload as { comparison?: unknown })?.comparison;
    if (!comparison || typeof comparison !== "object" || typeof (comparison as TagEngineStoredComparison).id !== "string") {
      throw new Error("TagEngine returned invalid comparison");
    }
    return comparison as TagEngineStoredComparison;
  }

  async listComparisons(input: { volumeId?: string; limit?: number } = {}): Promise<TagEngineStoredComparison[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500");
    const query = new URLSearchParams({ limit: String(limit) });
    if (input.volumeId) query.set("volumeId", input.volumeId);
    const payload = await this.requestJson("/api/snapshot-comparisons?" + query.toString());
    const comparisons = (payload as { comparisons?: unknown })?.comparisons;
    if (!Array.isArray(comparisons)) throw new Error("TagEngine returned invalid comparison list");
    return comparisons as TagEngineStoredComparison[];
  }

  async getComparison(id: string): Promise<TagEngineStoredComparison> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("comparison id must be a UUID");
    const payload = await this.requestJson("/api/snapshot-comparisons/" + encodeURIComponent(id));
    const comparison = (payload as { comparison?: unknown })?.comparison;
    if (!comparison || typeof comparison !== "object") throw new Error("TagEngine returned invalid comparison");
    return comparison as TagEngineStoredComparison;
  }

  async runRetention(input: { retentionDays: number; keepLatestPerVolume?: number; dryRun?: boolean }): Promise<TagEngineRetentionResult> {
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) {
      throw new Error("retentionDays must be an integer from 1 to 3650");
    }
    if (input.keepLatestPerVolume !== undefined &&
        (!Number.isInteger(input.keepLatestPerVolume) || input.keepLatestPerVolume < 0 || input.keepLatestPerVolume > 1000)) {
      throw new Error("keepLatestPerVolume must be an integer from 0 to 1000");
    }
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new Error("dryRun must be boolean");
    const payload = await this.requestJson("/api/maintenance/retention", {
      method: "POST",
      body: JSON.stringify({ ...input, dryRun: input.dryRun ?? true })
    });
    const retention = (payload as { retention?: unknown })?.retention;
    if (!retention || typeof retention !== "object" || typeof (retention as TagEngineRetentionResult).dryRun !== "boolean") {
      throw new Error("TagEngine returned invalid retention result");
    }
    return retention as TagEngineRetentionResult;
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
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          ...(this.apiToken ? { "authorization": "Bearer " + this.apiToken } : {})
        },
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
