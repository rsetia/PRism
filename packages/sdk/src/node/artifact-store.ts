import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePathComponent, encodePathComponent } from "./path-component.js";

/**
 * The ArtifactStore port (plan §14, from PRism-py). It owns worker output
 * files: the bytes live here, the metadata (which artifacts exist) lives
 * in the run state. Artifacts are addressed by URI, not filesystem path —
 * that is the one change that keeps result.json backend-agnostic, so a
 * worker on a remote pod can `put` and the orchestrator can `get` without
 * sharing a filesystem.
 */

export interface ArtifactRef {
  /** Opaque locator resolvable by the store that produced it. */
  readonly uri: string;
  readonly filename: string;
  readonly contentType?: string;
  /** Size in bytes. */
  readonly size: number;
}

export interface PutArtifactInput {
  readonly runId: string;
  readonly nodeId: string;
  /** 1-based attempt the artifact belongs to. */
  readonly attempt: number;
  readonly filename: string;
  readonly data: Uint8Array;
  readonly contentType?: string;
}

export interface ArtifactLocator {
  readonly runId: string;
  readonly nodeId: string;
}

export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactRef>;
  get(uri: string): Promise<Uint8Array>;
  /** All artifacts for a node, across attempts. */
  list(locator: ArtifactLocator): Promise<readonly ArtifactRef[]>;
}

export interface LocalArtifactStoreOptions {
  /** Root directory the artifact tree lives under. */
  readonly baseDir: string;
}

/**
 * Store artifacts as files under baseDir (plan §14). The local analogue
 * of the future S3 store — same URI-addressed contract, different bytes
 * location.
 */
export function createLocalArtifactStore(
  options: LocalArtifactStoreOptions,
): ArtifactStore {
  const baseDir = resolve(options.baseDir);
  const contentTypes = new Map<string, string>();

  return Object.freeze({
    async put(input: PutArtifactInput): Promise<ArtifactRef> {
      validateAttempt(input.attempt);
      const filename = encodePathComponent(input.filename, "artifact filename");
      const directory = resolve(
        baseDir,
        encodePathComponent(input.runId, "artifact runId"),
        encodePathComponent(input.nodeId, "artifact nodeId"),
        `a${String(input.attempt)}`,
      );
      await mkdir(directory, { recursive: true });

      const path = resolve(directory, filename);
      assertContained(baseDir, path);
      const [realBase, realDirectory] = await Promise.all([
        realpath(baseDir),
        realpath(directory),
      ]);
      assertContained(realBase, realDirectory);
      try {
        if ((await lstat(path)).isSymbolicLink()) {
          throw new Error(`Artifact path must not be a symbolic link: ${path}`);
        }
      } catch (error: unknown) {
        if (!isErrnoException(error, "ENOENT")) {
          throw error;
        }
      }
      await writeFile(path, input.data);

      if (input.contentType === undefined) {
        contentTypes.delete(path);
      } else {
        contentTypes.set(path, input.contentType);
      }

      return artifactRef(
        path,
        input.filename,
        input.data.byteLength,
        input.contentType,
      );
    },

    async get(uri: string): Promise<Uint8Array> {
      let path: string;
      try {
        path = resolve(fileURLToPath(uri));
      } catch (error: unknown) {
        throw new Error(`Invalid artifact URI: ${uri}`, { cause: error });
      }
      assertContained(baseDir, path);

      let realBase: string;
      let realArtifact: string;
      try {
        [realBase, realArtifact] = await Promise.all([
          realpath(baseDir),
          realpath(path),
        ]);
      } catch (error: unknown) {
        if (isErrnoException(error, "ENOENT")) {
          throw unknownArtifact(uri, error);
        }
        throw error;
      }
      assertContained(realBase, realArtifact);

      try {
        return new Uint8Array(await readFile(realArtifact));
      } catch (error: unknown) {
        if (isErrnoException(error, "ENOENT")) {
          throw unknownArtifact(uri, error);
        }
        throw error;
      }
    },

    async list(locator: ArtifactLocator): Promise<readonly ArtifactRef[]> {
      const nodeDir = resolve(
        baseDir,
        encodePathComponent(locator.runId, "artifact runId"),
        encodePathComponent(locator.nodeId, "artifact nodeId"),
      );
      assertContained(baseDir, nodeDir);

      let attempts;
      try {
        attempts = await readdir(nodeDir, { withFileTypes: true });
      } catch (error: unknown) {
        if (isErrnoException(error, "ENOENT")) {
          return [];
        }
        throw error;
      }
      const [realBase, realNodeDir] = await Promise.all([
        realpath(baseDir),
        realpath(nodeDir),
      ]);
      assertContained(realBase, realNodeDir);

      const refs: ArtifactRef[] = [];
      for (const attempt of attempts
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const attemptDir = resolve(nodeDir, attempt.name);
        const entries = await readdir(attemptDir, { withFileTypes: true });
        for (const entry of entries
          .filter((candidate) => candidate.isFile())
          .sort((left, right) => left.name.localeCompare(right.name))) {
          const path = resolve(attemptDir, entry.name);
          assertContained(baseDir, path);
          const metadata = await stat(path);
          refs.push(
            artifactRef(
              path,
              decodePathComponent(entry.name, "artifact filename"),
              metadata.size,
              contentTypes.get(path),
            ),
          );
        }
      }
      return Object.freeze(refs);
    },
  });
}

function artifactRef(
  path: string,
  filename: string,
  size: number,
  contentType: string | undefined,
): ArtifactRef {
  return Object.freeze(
    contentType === undefined
      ? { uri: pathToFileURL(path).href, filename, size }
      : { uri: pathToFileURL(path).href, filename, size, contentType },
  );
}

function assertContained(baseDir: string, candidate: string): void {
  const base = resolve(baseDir);
  const path = resolve(candidate);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  if (path === base || !path.startsWith(prefix)) {
    throw new Error(`Artifact URI is outside the store: ${candidate}`);
  }
}

function validateAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("artifact attempt must be an integer greater than 0");
  }
}

function unknownArtifact(uri: string, cause: unknown): Error {
  return new Error(`Unknown artifact: ${uri}`, { cause });
}

function isErrnoException(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
