/** Host-side policy for processes that can execute agent-authored work. */
export type AgentExecutionMode = "isolated" | "trusted-local";

export interface ChildEnvironmentPolicy {
  /** Parent variables to copy. `"all"` is only valid in trusted-local mode. */
  readonly inherit?: "all" | readonly string[];
  /** Explicit values supplied by the host, after inherited values. */
  readonly values?: Readonly<Record<string, string | undefined>>;
  /** Variables whose values must be removed from logs and persisted errors. */
  readonly secretNames?: readonly string[];
  /** Additional literal values to redact (useful for scoped credentials). */
  readonly redactValues?: readonly string[];
}

export interface AgentExecutionPolicy {
  readonly mode: AgentExecutionMode;
  readonly environment?: ChildEnvironmentPolicy;
}

export interface SecretRedactor {
  (value: string): string;
  /** Descending-length literals, exposed for boundary-safe stream filtering. */
  readonly secrets: readonly string[];
}

/** Least-privilege default: only PATH crosses the process boundary. */
export const SAFE_AGENT_EXECUTION_POLICY: AgentExecutionPolicy = Object.freeze({
  mode: "isolated",
  environment: Object.freeze({ inherit: Object.freeze(["PATH"]) }),
});

/** Compatibility policy for explicitly trusted, single-user machines. */
export const TRUSTED_LOCAL_AGENT_EXECUTION_POLICY: AgentExecutionPolicy =
  Object.freeze({
    mode: "trusted-local",
    environment: Object.freeze({ inherit: "all" }),
  });

export function validateAgentExecutionPolicy(
  policy: AgentExecutionPolicy,
): void {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error("executionPolicy must be an object");
  }
  if (policy.mode !== "isolated" && policy.mode !== "trusted-local") {
    throw new Error(
      'executionPolicy.mode must be "isolated" or "trusted-local"',
    );
  }
  const environment = policy.environment;
  if (
    environment !== undefined &&
    (typeof environment !== "object" ||
      environment === null ||
      Array.isArray(environment))
  ) {
    throw new Error("executionPolicy.environment must be an object");
  }
  if (environment?.inherit === "all" && policy.mode !== "trusted-local") {
    throw new Error(
      'executionPolicy.environment.inherit="all" requires trusted-local mode',
    );
  }
  if (
    environment?.inherit !== undefined &&
    environment.inherit !== "all" &&
    !Array.isArray(environment.inherit)
  ) {
    throw new Error(
      'executionPolicy.environment.inherit must be "all" or an array',
    );
  }
  if (Array.isArray(environment?.inherit)) {
    validateNames(environment.inherit, "executionPolicy.environment.inherit");
  }
  if (
    environment?.secretNames !== undefined &&
    !Array.isArray(environment.secretNames)
  ) {
    throw new Error("executionPolicy.environment.secretNames must be an array");
  }
  validateNames(
    environment?.secretNames ?? [],
    "executionPolicy.environment.secretNames",
  );
  if (
    environment?.values !== undefined &&
    (typeof environment.values !== "object" ||
      environment.values === null ||
      Array.isArray(environment.values))
  ) {
    throw new Error("executionPolicy.environment.values must be an object");
  }
  for (const [name, value] of Object.entries(environment?.values ?? {})) {
    validateName(name, "executionPolicy.environment.values");
    if (value !== undefined && typeof value !== "string") {
      throw new Error(
        `executionPolicy.environment.values[${JSON.stringify(name)}] must be a string or undefined`,
      );
    }
  }
  if (
    environment?.redactValues !== undefined &&
    !Array.isArray(environment.redactValues)
  ) {
    throw new Error(
      "executionPolicy.environment.redactValues must be an array",
    );
  }
  for (const value of environment?.redactValues ?? []) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        "executionPolicy.environment.redactValues must contain non-empty strings",
      );
    }
  }
}

export function buildChildEnvironment(
  policy: AgentExecutionPolicy,
  parent: Readonly<Record<string, string | undefined>>,
  required: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  validateAgentExecutionPolicy(policy);
  const environment = policy.environment;
  const child: Record<string, string | undefined> = {};
  if (environment?.inherit === "all") {
    Object.assign(child, parent);
  } else {
    for (const name of environment?.inherit ?? []) {
      const value = parent[name];
      if (value !== undefined) child[name] = value;
    }
  }
  for (const [name, value] of Object.entries(environment?.values ?? {})) {
    if (value === undefined) delete child[name];
    else child[name] = value;
  }
  Object.assign(child, required);
  return child;
}

export function createSecretRedactor(
  policy: AgentExecutionPolicy,
  parent: Readonly<Record<string, string | undefined>>,
): SecretRedactor {
  validateAgentExecutionPolicy(policy);
  const environment = policy.environment;
  const values = new Set<string>(environment?.redactValues ?? []);
  for (const name of environment?.secretNames ?? []) {
    const value = environment?.values?.[name] ?? parent[name];
    if (value !== undefined && value.length > 0) values.add(value);
  }
  const ordered = [...values].sort((left, right) => right.length - left.length);
  const redact = (value: string): string => {
    let redacted = value;
    for (const secret of ordered) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  };
  return Object.assign(redact, { secrets: Object.freeze(ordered) });
}

function validateNames(names: readonly string[], field: string): void {
  for (const name of names) validateName(name, field);
}

function validateName(name: string, field: string): void {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `${field} contains invalid environment variable ${JSON.stringify(name)}`,
    );
  }
}
