import { describe, expect, test } from "vitest";
import {
  createLinearPollSource,
  parseLinearSourceConfig,
} from "../src/node/index.js";
import type { PollSourceConfig } from "../src/node/index.js";

const VIEWER = "viewer-1";
const LABEL_ID = "label-agent";
const signal = new AbortController().signal;
const config = {
  kind: "linear",
  label: "agent-implemented",
} as unknown as PollSourceConfig;

interface Call {
  readonly authorization: string | null;
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

function fakeLinear(responses: readonly unknown[], status = 200) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = ((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({
      authorization: new Headers(init.headers).get("authorization"),
      query: body.query,
      variables: body.variables,
    });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function issue(identifier: string, extra: Record<string, unknown> = {}) {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `Title ${identifier}`,
    url: `https://linear.app/x/issue/${identifier}`,
    creator: { id: VIEWER },
    labels: { nodes: [{ id: LABEL_ID, name: "agent-implemented" }] },
    history: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...extra,
  };
}

function page(
  issues: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      viewer: { id: VIEWER },
      issues: { pageInfo: { hasNextPage, endCursor }, nodes: issues },
    },
  };
}

const env = { LINEAR_API_KEY: "lin_api_secret" };

describe("parseLinearSourceConfig", () => {
  test("defaults to issues assigned to and labeled by me, unstarted, unblocked", () => {
    expect(parseLinearSourceConfig(config)).toEqual({
      label: "agent-implemented",
      labelAppliedBy: "me",
      assignee: "me",
      states: ["backlog", "unstarted"],
      skipBlocked: true,
      apiUrl: "https://api.linear.app/graphql",
    });
  });

  test.each([
    [{ ...config, labels: ["x"] }, 'unknown key "labels"'],
    [{ ...config, label: "" }, "source.label"],
    [{ ...config, states: ["doing"] }, "state types"],
    [{ ...config, assignee: "someone" }, "source.assignee"],
    [{ ...config, tokenEnv: "not a var" }, "environment variable name"],
  ])("rejects %j", (value, message) => {
    expect(() =>
      parseLinearSourceConfig(value as unknown as PollSourceConfig),
    ).toThrow(message);
  });
});

describe("Linear poll source", () => {
  test("filters by label, state, assignee, and team, and authenticates with the key", async () => {
    const { calls, fetchImpl } = fakeLinear([page([issue("ENG-1")])]);
    const source = createLinearPollSource({ fetch: fetchImpl, env });
    const listing = await source.list(
      { ...config, team: "ENG", states: ["unstarted"] },
      signal,
    );
    expect(listing).toEqual({
      candidates: [
        {
          key: "ENG-1",
          title: "Title ENG-1",
          url: "https://linear.app/x/issue/ENG-1",
        },
      ],
      skipped: [],
    });
    expect(calls[0]?.authorization).toBe("lin_api_secret");
    expect(calls[0]?.variables["filter"]).toEqual({
      labels: { some: { name: { eqIgnoreCase: "agent-implemented" } } },
      state: { type: { in: ["unstarted"] } },
      assignee: { isMe: { eq: true } },
      team: { key: { eq: "ENG" } },
    });
  });

  test("only queues labels the operator applied", async () => {
    const { fetchImpl } = fakeLinear([
      page([
        // Label set at creation by the viewer: no history entry.
        issue("ENG-1"),
        // Created by someone else, label added later by the viewer.
        issue("ENG-2", {
          creator: { id: "other" },
          history: {
            nodes: [
              {
                createdAt: "2026-09-30T10:00:00Z",
                addedLabelIds: [LABEL_ID],
                actor: { id: VIEWER },
              },
            ],
          },
        }),
        // Viewer added it first, then someone re-applied it most recently.
        issue("ENG-3", {
          history: {
            nodes: [
              {
                createdAt: "2026-09-30T10:00:00Z",
                addedLabelIds: [LABEL_ID],
                actor: { id: VIEWER },
              },
              {
                createdAt: "2026-09-30T11:00:00Z",
                addedLabelIds: [LABEL_ID],
                actor: { id: "other" },
              },
            ],
          },
        }),
        // Created by someone else with the label from the start.
        issue("ENG-4", { creator: { id: "other" } }),
      ]),
    ]);
    const listing = await createLinearPollSource({
      fetch: fetchImpl,
      env,
    }).list(config, signal);
    expect(listing.candidates.map((candidate) => candidate.key)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
    expect(listing.skipped).toEqual([
      {
        key: "ENG-3",
        reason: 'label "agent-implemented" was not applied by you',
      },
      {
        key: "ENG-4",
        reason: 'label "agent-implemented" was not applied by you',
      },
    ]);
  });

  test("labelAppliedBy anyone accepts labels from teammates", async () => {
    const { fetchImpl } = fakeLinear([
      page([issue("ENG-4", { creator: { id: "other" } })]),
    ]);
    const listing = await createLinearPollSource({
      fetch: fetchImpl,
      env,
    }).list({ ...config, labelAppliedBy: "anyone" }, signal);
    expect(listing.candidates.map((candidate) => candidate.key)).toEqual([
      "ENG-4",
    ]);
  });

  test.each([VIEWER, "other"])(
    "checks label provenance on later history pages for actor %s",
    async (actor) => {
      const { calls, fetchImpl } = fakeLinear([
        page([
          issue("ENG-1", {
            // Force the creator fallback to give the opposite answer.
            creator: { id: actor === VIEWER ? "other" : VIEWER },
            history: {
              nodes: Array.from({ length: 50 }, () => ({
                createdAt: "2026-09-01T00:00:00Z",
                addedLabelIds: [],
              })),
              pageInfo: { hasNextPage: true, endCursor: "history-1" },
            },
          }),
        ]),
        {
          data: {
            issue: {
              history: {
                nodes: [
                  {
                    createdAt: "2026-09-30T00:00:00Z",
                    addedLabelIds: [LABEL_ID],
                    actor: { id: actor },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ]);
      const listing = await createLinearPollSource({
        fetch: fetchImpl,
        env,
      }).list(config, signal);
      expect(listing.candidates.map((entry) => entry.key)).toEqual(
        actor === VIEWER ? ["ENG-1"] : [],
      );
      expect(listing.skipped).toHaveLength(actor === VIEWER ? 0 : 1);
      expect(calls[1]?.variables).toEqual({
        id: "uuid-ENG-1",
        after: "history-1",
      });
      expect(calls[1]?.query).toContain("history(first: 50, after: $after)");
    },
  );

  test("uses the newest label addition across pages regardless of history order", async () => {
    const addition = (createdAt: string, actor: string) => ({
      createdAt,
      addedLabelIds: [LABEL_ID],
      actor: { id: actor },
    });
    const { fetchImpl } = fakeLinear([
      page([
        issue("ENG-1", {
          history: {
            nodes: [addition("2026-09-30T00:00:00Z", "other")],
            pageInfo: { hasNextPage: true, endCursor: "history-1" },
          },
        }),
      ]),
      {
        data: {
          issue: {
            history: {
              nodes: [addition("2026-09-01T00:00:00Z", VIEWER)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const listing = await createLinearPollSource({
      fetch: fetchImpl,
      env,
    }).list(config, signal);
    expect(listing.candidates).toEqual([]);
    expect(listing.skipped[0]?.reason).toContain("was not applied by you");
  });

  test("checks blockers beyond the first relation page", async () => {
    const { fetchImpl } = fakeLinear([
      page([
        issue("ENG-1", {
          inverseRelations: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "relations-1" },
          },
        }),
      ]),
      {
        data: {
          issue: {
            inverseRelations: {
              nodes: [
                {
                  type: "blocks",
                  issue: { identifier: "ENG-9", state: { type: "started" } },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const listing = await createLinearPollSource({
      fetch: fetchImpl,
      env,
    }).list(config, signal);
    expect(listing).toEqual({
      candidates: [],
      skipped: [{ key: "ENG-1", reason: "blocked by ENG-9" }],
    });
  });

  test.each([null, "history-1"])(
    "fails closed when history pagination returns invalid cursor %s",
    async (endCursor) => {
      const { fetchImpl } = fakeLinear([
        page([
          issue("ENG-1", {
            history: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "history-1" },
            },
          }),
        ]),
        {
          data: {
            issue: {
              history: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor },
              },
            },
          },
        },
      ]);
      await expect(
        createLinearPollSource({ fetch: fetchImpl, env }).list(config, signal),
      ).rejects.toThrow("invalid pagination cursor");
    },
  );

  test("skips issues blocked by unfinished work", async () => {
    const blocked = (state: string) => ({
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: { identifier: "ENG-9", state: { type: state } },
          },
          {
            type: "related",
            issue: { identifier: "ENG-8", state: { type: "started" } },
          },
        ],
      },
    });
    const { fetchImpl } = fakeLinear([
      page([
        issue("ENG-1", blocked("started")),
        issue("ENG-2", blocked("completed")),
      ]),
    ]);
    const listing = await createLinearPollSource({
      fetch: fetchImpl,
      env,
    }).list(config, signal);
    expect(listing.candidates.map((candidate) => candidate.key)).toEqual([
      "ENG-2",
    ]);
    expect(listing.skipped).toEqual([
      { key: "ENG-1", reason: "blocked by ENG-9" },
    ]);
  });

  test("follows pagination", async () => {
    const { calls, fetchImpl } = fakeLinear([
      page([issue("ENG-1")], true, "cursor-1"),
      page([issue("ENG-2")]),
    ]);
    const listing = await createLinearPollSource({
      fetch: fetchImpl,
      env,
    }).list(config, signal);
    expect(listing.candidates.map((candidate) => candidate.key)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
    expect(calls[1]?.variables["after"]).toBe("cursor-1");
  });

  test("does not starve candidates beyond the former ten-page limit", async () => {
    const { calls, fetchImpl } = fakeLinear(
      Array.from({ length: 11 }, (_, index) =>
        page(
          [issue(`ENG-${String(index)}`)],
          index < 10,
          `page-${String(index)}`,
        ),
      ),
    );
    const listing = await createLinearPollSource({
      fetch: fetchImpl,
      env,
    }).list(config, signal);
    expect(calls).toHaveLength(11);
    expect(listing.candidates.at(-1)?.key).toBe("ENG-10");
  });

  test("snapshots all pages of every issue connection", async () => {
    const connections = {
      labels: [{ name: "second label" }],
      comments: [{ body: "acceptance criteria on page two" }],
      attachments: [{ title: "design", url: "https://example.com/design" }],
      relations: [{ type: "blocks", relatedIssue: { identifier: "ENG-2" } }],
      inverseRelations: [{ type: "blocks", issue: { identifier: "ENG-3" } }],
    };
    const { calls, fetchImpl } = fakeLinear([
      {
        data: {
          issue: {
            id: "uuid-ENG-1",
            ...Object.fromEntries(
              Object.keys(connections).map((name) => [
                name,
                {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: `${name}-1` },
                },
              ]),
            ),
          },
        },
      },
      ...Object.entries(connections).map(([name, entries]) => ({
        data: {
          issue: {
            [name]: {
              nodes: entries,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })),
    ]);
    const loaded = await createLinearPollSource({ fetch: fetchImpl, env }).load(
      config,
      { key: "ENG-1", title: "Snapshot" },
      signal,
    );
    expect(calls).toHaveLength(6);
    expect(loaded.snapshot).toMatchObject({
      labels: ["second label"],
      comments: connections.comments,
      attachments: connections.attachments,
      relations: {
        blocks: [{ identifier: "ENG-2" }],
        blockedBy: [{ identifier: "ENG-3" }],
      },
    });
  });

  test("snapshots the full issue for the implementer", async () => {
    const { calls, fetchImpl } = fakeLinear([
      {
        data: {
          issue: {
            id: "uuid-ENG-2142",
            identifier: "ENG-2142",
            title: "Add routing",
            description: "## Acceptance criteria\n* works",
            url: "https://linear.app/x/issue/ENG-2142",
            branchName: "rav/eng-2142-add-routing",
            priorityLabel: "No priority",
            createdAt: "2026-09-30T21:36:27.776Z",
            updatedAt: "2026-09-30T21:36:27.776Z",
            creator: { name: "Rav" },
            assignee: { name: "Rav" },
            team: { key: "ENG", name: "Engineering" },
            state: { name: "Backlog", type: "backlog" },
            project: null,
            labels: {
              nodes: [{ name: "agent-implemented" }, { name: "Feature" }],
            },
            parent: null,
            comments: {
              nodes: [
                {
                  body: "second",
                  createdAt: "2026-09-30T23:00:00Z",
                  user: { name: "B" },
                },
                {
                  body: "first",
                  createdAt: "2026-09-30T22:00:00Z",
                  user: { name: "A" },
                },
              ],
            },
            attachments: {
              nodes: [{ title: "PR", url: "https://github.com/x/y/pull/1" }],
            },
            relations: {
              nodes: [
                {
                  type: "related",
                  relatedIssue: {
                    identifier: "ENG-2133",
                    title: "Steer",
                    url: "u",
                    state: { name: "In Progress", type: "started" },
                  },
                },
              ],
            },
            inverseRelations: {
              nodes: [
                {
                  type: "blocks",
                  issue: {
                    identifier: "ENG-1",
                    title: "Base",
                    url: "b",
                    state: { name: "Done", type: "completed" },
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    const source = createLinearPollSource({
      fetch: fetchImpl,
      env,
      now: () => Date.parse("2026-10-01T00:00:00Z"),
    });
    const loaded = await source.load(
      config,
      { key: "ENG-2142", title: "Add routing" },
      signal,
    );
    expect(calls[0]?.variables).toEqual({ id: "ENG-2142" });
    expect(loaded).toMatchObject({
      key: "ENG-2142",
      title: "Add routing",
      url: "https://linear.app/x/issue/ENG-2142",
      branchName: "rav/eng-2142-add-routing",
    });
    expect(loaded.snapshot).toMatchObject({
      description: "## Acceptance criteria\n* works",
      state: "Backlog",
      team: "ENG",
      labels: ["agent-implemented", "Feature"],
      comments: [
        { author: "A", body: "first" },
        { author: "B", body: "second" },
      ],
      attachments: [{ title: "PR", url: "https://github.com/x/y/pull/1" }],
      relations: {
        blockedBy: [{ identifier: "ENG-1", state: "Done" }],
        blocks: [],
        related: [{ identifier: "ENG-2133", state: "In Progress" }],
      },
      capturedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  test("reads the token from a named variable and explains a missing one", async () => {
    const { calls, fetchImpl } = fakeLinear([page([])]);
    const named = { ...config, tokenEnv: "MY_LINEAR" } as PollSourceConfig;
    await createLinearPollSource({
      fetch: fetchImpl,
      env: { MY_LINEAR: "k2" },
    }).list(named, signal);
    expect(calls[0]?.authorization).toBe("k2");
    await expect(
      createLinearPollSource({ fetch: fetchImpl, env: {} }).list(named, signal),
    ).rejects.toThrow("MY_LINEAR is empty or unset (is it exported?)");
    await expect(
      createLinearPollSource({ fetch: fetchImpl, env: {} }).list(
        config,
        signal,
      ),
    ).rejects.toThrow("export LINEAR_API_KEY (or LINEAR_TOKEN)");
    await createLinearPollSource({
      fetch: fetchImpl,
      env: { LINEAR_TOKEN: "k3" },
    }).list(config, signal);
    expect(calls.at(-1)?.authorization).toBe("k3");
  });

  test("surfaces API errors without echoing the token", async () => {
    const { fetchImpl } = fakeLinear(
      [{ errors: [{ message: "Authentication required" }] }],
      401,
    );
    const failure = createLinearPollSource({ fetch: fetchImpl, env }).list(
      config,
      signal,
    );
    await expect(failure).rejects.toThrow(
      "Linear API error: Authentication required",
    );
    await expect(failure).rejects.not.toThrow("lin_api_secret");
  });

  test("preflight names the authenticated user", async () => {
    const { fetchImpl } = fakeLinear([
      { data: { viewer: { id: VIEWER, name: "Rav" } } },
    ]);
    await expect(
      createLinearPollSource({ fetch: fetchImpl, env }).preflight?.(config),
    ).resolves.toBe("Linear authenticated as Rav");
  });
});
