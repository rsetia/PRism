import type { JsonValue } from "../graph/types.js";
import type {
  PollCandidate,
  PollItem,
  PollListing,
  PollSkip,
  PollSource,
  PollSourceConfig,
} from "./poll.js";

/**
 * Linear as a poll source. The poll condition is: carries the trigger
 * label, sits in one of the configured workflow state types, and (by
 * default) is assigned to the token's user and had the label applied by
 * that user. The last rule matters because implementers run with the
 * operator's credentials: anyone in the workspace can add a label, so a
 * label someone else applied is not a request from the operator.
 */

export const LINEAR_API_URL = "https://api.linear.app/graphql";
const DEFAULT_STATE_TYPES = Object.freeze(["backlog", "unstarted"]);
const STATE_TYPES: ReadonlySet<string> = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);
const DONE_STATE_TYPES: ReadonlySet<string> = new Set([
  "completed",
  "canceled",
]);
const SOURCE_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "label",
  "labelAppliedBy",
  "assignee",
  "team",
  "states",
  "skipBlocked",
  "tokenEnv",
  "apiUrl",
]);
const PAGE_SIZE = 50;

export interface LinearSourceConfig {
  readonly label: string;
  readonly labelAppliedBy: "me" | "anyone";
  readonly assignee: "me" | "anyone";
  readonly team?: string;
  readonly states: readonly string[];
  readonly skipBlocked: boolean;
  readonly tokenEnv?: string;
  readonly apiUrl: string;
}

export interface LinearPollSourceOptions {
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Snapshot timestamp source. Default Date.now. */
  readonly now?: () => number;
}

export function parseLinearSourceConfig(
  config: PollSourceConfig,
): LinearSourceConfig {
  for (const key of Object.keys(config)) {
    if (!SOURCE_KEYS.has(key)) {
      throw new Error(`source has unknown key "${key}"`);
    }
  }
  if (config.kind !== "linear") {
    throw new Error(`source.kind must be "linear", received "${config.kind}"`);
  }
  const label = config["label"];
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error(
      "source.label must name the Linear label that triggers work",
    );
  }
  const labelAppliedBy = oneOf(
    config["labelAppliedBy"],
    "source.labelAppliedBy",
    ["me", "anyone"] as const,
    "me",
  );
  const assignee = oneOf(
    config["assignee"],
    "source.assignee",
    ["me", "anyone"] as const,
    "me",
  );
  const team = config["team"];
  if (team !== undefined && (typeof team !== "string" || team.trim() === "")) {
    throw new Error("source.team must be a Linear team key");
  }
  const statesValue = config["states"];
  let states: readonly string[] = DEFAULT_STATE_TYPES;
  if (statesValue !== undefined) {
    if (
      !Array.isArray(statesValue) ||
      statesValue.length === 0 ||
      statesValue.some(
        (state) => typeof state !== "string" || !STATE_TYPES.has(state),
      )
    ) {
      throw new Error(
        `source.states must be a non-empty list of Linear state types: ${[...STATE_TYPES].join(", ")}`,
      );
    }
    states = Object.freeze([...(statesValue as string[])]);
  }
  const skipBlocked = config["skipBlocked"];
  if (skipBlocked !== undefined && typeof skipBlocked !== "boolean") {
    throw new Error("source.skipBlocked must be a boolean");
  }
  const tokenEnv = config["tokenEnv"];
  if (
    tokenEnv !== undefined &&
    (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv))
  ) {
    throw new Error("source.tokenEnv must be an environment variable name");
  }
  const apiUrl = config["apiUrl"];
  if (apiUrl !== undefined && typeof apiUrl !== "string") {
    throw new Error("source.apiUrl must be a URL string");
  }
  return Object.freeze({
    label: label.trim(),
    labelAppliedBy,
    assignee,
    ...(team === undefined ? {} : { team: team.trim() }),
    states,
    skipBlocked: skipBlocked ?? true,
    ...(tokenEnv === undefined ? {} : { tokenEnv: tokenEnv }),
    apiUrl: apiUrl ?? LINEAR_API_URL,
  });
}

const CONNECTION_FIELDS = {
  labels: "id name",
  history: "createdAt addedLabelIds actor { id }",
  comments: "body createdAt user { name }",
  attachments: "title url",
  relations: "type relatedIssue { identifier title url state { name type } }",
  inverseRelations: "type issue { identifier title url state { name type } }",
} as const;
type IssueConnection = keyof typeof CONNECTION_FIELDS;

function connectionSelection(name: IssueConnection, after = false): string {
  return `${name}(first: ${String(PAGE_SIZE)}${after ? ", after: $after" : ""}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${CONNECTION_FIELDS[name]} }
  }`;
}

const CANDIDATES_QUERY = `query PrismPollCandidates($filter: IssueFilter, $after: String) {
  viewer { id }
  issues(first: ${String(PAGE_SIZE)}, after: $after, filter: $filter, orderBy: createdAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title url
      creator { id }
      ${connectionSelection("labels")}
      ${connectionSelection("history")}
      ${connectionSelection("inverseRelations")}
    }
  }
}`;

const ISSUE_QUERY = `query PrismPollIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url branchName priority priorityLabel createdAt updatedAt
    creator { name } assignee { name }
    team { key name } state { name type } project { name }
    ${connectionSelection("labels")}
    parent { identifier title url }
    ${connectionSelection("comments")}
    ${connectionSelection("attachments")}
    ${connectionSelection("relations")}
    ${connectionSelection("inverseRelations")}
  }
}`;

const VIEWER_QUERY = `query PrismPollViewer { viewer { id name email } }`;

export function createLinearPollSource(
  options: LinearPollSourceOptions = {},
): PollSource {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;

  async function graphql(
    config: LinearSourceConfig,
    query: string,
    variables: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const token = resolveToken(config, env);
    const response = await fetchImpl(config.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ query, variables }),
      ...(signal === undefined ? {} : { signal }),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const errors = record(body)?.["errors"];
    if (Array.isArray(errors) && errors.length > 0) {
      const messages = errors
        .map((error) => text(record(error)?.["message"]) ?? "unknown error")
        .join("; ");
      throw new Error(`Linear API error: ${messages}`);
    }
    if (!response.ok) {
      throw new Error(`Linear API returned HTTP ${String(response.status)}`);
    }
    const data = record(record(body)?.["data"]);
    if (data === undefined) {
      throw new Error("Linear API returned no data");
    }
    return data;
  }

  // Complete every connection before using it for authorization, blocking,
  // or task context. A partial history cannot justify the creator fallback,
  // and a partial relation list cannot establish that an issue is unblocked.
  async function completeConnections(
    config: LinearSourceConfig,
    issue: Record<string, unknown>,
    id: string,
    names: readonly IssueConnection[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const name of names) {
      let connection = record(issue[name]);
      const all = nodes(connection);
      const cursors = new Set<string>();
      let after = nextCursor(connection, cursors);
      while (after !== null) {
        const data = await graphql(
          config,
          `query PrismPollIssueConnection($id: String!, $after: String) {
            issue(id: $id) { ${connectionSelection(name, true)} }
          }`,
          { id, after },
          signal,
        );
        connection = record(record(data["issue"])?.[name]);
        if (connection === undefined) {
          throw new Error(`Linear issue ${id} returned no ${name} page`);
        }
        all.push(...nodes(connection));
        after = nextCursor(connection, cursors);
      }
      issue[name] = { nodes: all };
    }
  }

  return Object.freeze({
    kind: "linear",
    validateConfig(config: PollSourceConfig): void {
      parseLinearSourceConfig(config);
    },
    async preflight(
      config: PollSourceConfig,
      signal?: AbortSignal,
    ): Promise<string> {
      const parsed = parseLinearSourceConfig(config);
      const data = await graphql(parsed, VIEWER_QUERY, {}, signal);
      const viewer = record(data["viewer"]);
      return `Linear authenticated as ${text(viewer?.["name"]) ?? text(viewer?.["email"]) ?? "unknown user"}`;
    },
    async list(
      config: PollSourceConfig,
      signal: AbortSignal,
    ): Promise<PollListing> {
      const parsed = parseLinearSourceConfig(config);
      const filter = issueFilter(parsed);
      const candidates: PollCandidate[] = [];
      const skipped: PollSkip[] = [];
      let after: string | null = null;
      const cursors = new Set<string>();
      do {
        const data = await graphql(
          parsed,
          CANDIDATES_QUERY,
          { filter, ...(after === null ? {} : { after }) },
          signal,
        );
        const viewerId = text(record(data["viewer"])?.["id"]);
        const issues = record(data["issues"]);
        for (const issue of nodes(issues)) {
          const key = text(issue["identifier"]);
          const title = text(issue["title"]) ?? "";
          if (key === undefined) continue;
          await completeConnections(
            parsed,
            issue,
            text(issue["id"]) ?? key,
            [
              ...(parsed.labelAppliedBy === "me"
                ? (["labels", "history"] as const)
                : []),
              ...(parsed.skipBlocked ? (["inverseRelations"] as const) : []),
            ],
            signal,
          );
          const reason = skipReason(parsed, issue, viewerId);
          if (reason !== undefined) {
            skipped.push({ key, reason });
            continue;
          }
          const url = text(issue["url"]);
          candidates.push({
            key,
            title,
            ...(url === undefined ? {} : { url }),
          });
        }
        after = nextCursor(issues, cursors);
      } while (after !== null);
      return { candidates, skipped };
    },
    async load(
      config: PollSourceConfig,
      candidate: PollCandidate,
      signal: AbortSignal,
    ): Promise<PollItem> {
      const parsed = parseLinearSourceConfig(config);
      const data = await graphql(
        parsed,
        ISSUE_QUERY,
        { id: candidate.key },
        signal,
      );
      const issue = record(data["issue"]);
      if (issue === undefined) {
        throw new Error(`Linear issue ${candidate.key} was not found`);
      }
      await completeConnections(
        parsed,
        issue,
        text(issue["id"]) ?? candidate.key,
        ["labels", "comments", "attachments", "relations", "inverseRelations"],
        signal,
      );
      const snapshot = linearSnapshot(issue, now());
      const branchName = text(issue["branchName"]);
      const url = text(issue["url"]) ?? candidate.url;
      return {
        key: candidate.key,
        title: text(issue["title"]) ?? candidate.title,
        ...(url === undefined ? {} : { url }),
        ...(branchName === undefined ? {} : { branchName }),
        snapshot,
      };
    },
  });
}

function issueFilter(config: LinearSourceConfig): Record<string, JsonValue> {
  return {
    labels: { some: { name: { eqIgnoreCase: config.label } } },
    state: { type: { in: [...config.states] } },
    ...(config.assignee === "me" ? { assignee: { isMe: { eq: true } } } : {}),
    ...(config.team === undefined
      ? {}
      : { team: { key: { eq: config.team } } }),
  };
}

function skipReason(
  config: LinearSourceConfig,
  issue: Record<string, unknown>,
  viewerId: string | undefined,
): string | undefined {
  if (config.labelAppliedBy === "me") {
    const labelIds = new Set(
      nodes(record(issue["labels"]))
        .filter(
          (label) =>
            text(label["name"])?.toLowerCase() === config.label.toLowerCase(),
        )
        .flatMap((label) => {
          const id = text(label["id"]);
          return id === undefined ? [] : [id];
        }),
    );
    const additions = nodes(record(issue["history"]))
      .filter((entry) => {
        const added = entry["addedLabelIds"];
        return (
          Array.isArray(added) &&
          added.some((id) => typeof id === "string" && labelIds.has(id))
        );
      })
      .sort((left, right) =>
        (text(right["createdAt"]) ?? "").localeCompare(
          text(left["createdAt"]) ?? "",
        ),
      );
    // A label present from creation has no history entry: the creator set it.
    const applierId =
      additions.length > 0
        ? text(record(additions[0]?.["actor"])?.["id"])
        : text(record(issue["creator"])?.["id"]);
    if (viewerId === undefined || applierId !== viewerId) {
      return `label "${config.label}" was not applied by you`;
    }
  }
  if (config.skipBlocked) {
    const blockers = nodes(record(issue["inverseRelations"]))
      .filter((relation) => relation["type"] === "blocks")
      .map((relation) => record(relation["issue"]))
      .filter(
        (blocker) =>
          blocker !== undefined &&
          !DONE_STATE_TYPES.has(text(record(blocker["state"])?.["type"]) ?? ""),
      )
      .map((blocker) => text(blocker?.["identifier"]) ?? "an issue");
    if (blockers.length > 0) {
      return `blocked by ${blockers.join(", ")}`;
    }
  }
  return undefined;
}

function linearSnapshot(
  issue: Record<string, unknown>,
  nowMs: number,
): Readonly<Record<string, JsonValue>> {
  const relation = (entry: Record<string, unknown> | undefined): JsonValue => ({
    identifier: text(entry?.["identifier"]) ?? null,
    title: text(entry?.["title"]) ?? null,
    url: text(entry?.["url"]) ?? null,
    state: text(record(entry?.["state"])?.["name"]) ?? null,
  });
  const outgoing = nodes(record(issue["relations"]));
  const incoming = nodes(record(issue["inverseRelations"]));
  const comments = nodes(record(issue["comments"]))
    .map((comment) => ({
      author: text(record(comment["user"])?.["name"]) ?? null,
      createdAt: text(comment["createdAt"]) ?? null,
      body: text(comment["body"]) ?? "",
    }))
    .sort((left, right) =>
      (left.createdAt ?? "").localeCompare(right.createdAt ?? ""),
    );
  const parent = record(issue["parent"]);
  return Object.freeze({
    linearId: text(issue["id"]) ?? null,
    title: text(issue["title"]) ?? null,
    url: text(issue["url"]) ?? null,
    description: text(issue["description"]) ?? "",
    branchName: text(issue["branchName"]) ?? null,
    state: text(record(issue["state"])?.["name"]) ?? null,
    team: text(record(issue["team"])?.["key"]) ?? null,
    project: text(record(issue["project"])?.["name"]) ?? null,
    priority: text(issue["priorityLabel"]) ?? null,
    assignee: text(record(issue["assignee"])?.["name"]) ?? null,
    creator: text(record(issue["creator"])?.["name"]) ?? null,
    createdAt: text(issue["createdAt"]) ?? null,
    updatedAt: text(issue["updatedAt"]) ?? null,
    labels: nodes(record(issue["labels"])).flatMap((label) => {
      const name = text(label["name"]);
      return name === undefined ? [] : [name];
    }),
    parent:
      parent === undefined
        ? null
        : {
            identifier: text(parent["identifier"]) ?? null,
            title: text(parent["title"]) ?? null,
            url: text(parent["url"]) ?? null,
          },
    comments,
    attachments: nodes(record(issue["attachments"])).map((attachment) => ({
      title: text(attachment["title"]) ?? null,
      url: text(attachment["url"]) ?? null,
    })),
    relations: {
      blockedBy: incoming
        .filter((entry) => entry["type"] === "blocks")
        .map((entry) => relation(record(entry["issue"]))),
      blocks: outgoing
        .filter((entry) => entry["type"] === "blocks")
        .map((entry) => relation(record(entry["relatedIssue"]))),
      related: [
        ...outgoing
          .filter((entry) => entry["type"] !== "blocks")
          .map((entry) => relation(record(entry["relatedIssue"]))),
        ...incoming
          .filter((entry) => entry["type"] !== "blocks")
          .map((entry) => relation(record(entry["issue"]))),
      ],
    },
    capturedAt: new Date(nowMs).toISOString(),
  });
}

function resolveToken(
  config: LinearSourceConfig,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (config.tokenEnv !== undefined) {
    const token = env[config.tokenEnv]?.trim();
    if (token === undefined || token.length === 0) {
      throw new Error(
        `Linear token not found: environment variable ${config.tokenEnv} is empty or unset (is it exported?)`,
      );
    }
    return token;
  }
  const token = (env["LINEAR_API_KEY"] ?? env["LINEAR_TOKEN"])?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error(
      "Linear token not found: export LINEAR_API_KEY (or LINEAR_TOKEN), or name the variable with source.tokenEnv",
    );
  }
  return token;
}

function oneOf<const T extends string>(
  value: JsonValue | undefined,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nodes(
  connection: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const list = connection?.["nodes"];
  return Array.isArray(list)
    ? list.flatMap((entry) => {
        const value = record(entry);
        return value === undefined ? [] : [value];
      })
    : [];
}

function nextCursor(
  connection: Record<string, unknown> | undefined,
  seen: Set<string>,
): string | null {
  const pageInfo = record(connection?.["pageInfo"]);
  if (pageInfo?.["hasNextPage"] !== true) return null;
  const cursor = text(pageInfo["endCursor"]);
  if (cursor === undefined || cursor.length === 0 || seen.has(cursor)) {
    throw new Error("Linear API returned an invalid pagination cursor");
  }
  seen.add(cursor);
  return cursor;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
