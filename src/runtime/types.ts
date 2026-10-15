/** The small part of app-server's JSON-RPC contract used by this patch. */
export type JsonObject = Record<string, unknown>;
export type Sender = (
  method: string,
  params?: JsonObject | null,
  options?: JsonObject,
) => Promise<unknown>;

export interface RequestClient {
  hostId: string;
  sendRequest: Sender;
}

export interface RegisteredModel {
  profile: string;
  model: string;
  provider: string;
  providerName: string;
  effort: string;
  config: JsonObject;
}

export interface Registry {
  models: Map<string, RegisteredModel>;
  threads: Map<string, string>;
  loadedAt: number;
}

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
