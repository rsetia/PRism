import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ArtifactLocator,
  ArtifactRef,
  ArtifactStore,
  PutArtifactInput,
} from "../runtime/ports.js";
import { decodePathComponent, encodePathComponent } from "./path-component.js";
import { isPlainObject } from "../internal/json.js";

const METADATA_FILE = ".prism-artifacts-v1.json";
const METADATA_LOCK_FILE = ".prism-artifacts-v1.lock";
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

interface ArtifactMetadata {
  readonly filename: string;
  readonly size: number;
  readonly contentType?: string;
}

interface ArtifactManifest {
  readonly version: 1;
  readonly entries: Readonly<Record<string, ArtifactMetadata>>;
}

/**
 * The ArtifactStore port (plan §14, from PRism-py). It owns worker output
 * files: the bytes live here, the metadata (which artifacts exist) lives
 * in the run state. Artifacts are addressed by URI, not filesystem path —
 * that is the one change that keeps result.json backend-agnostic, so a
 * worker on a remote pod can `put` and the orchestrator can `get` without
 * sharing a filesystem.
 */

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
  const metadataWrites = new Map<string, Promise<void>>();

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

      const previousWrite = metadataWrites.get(directory) ?? Promise.resolve();
      const metadataWrite = previousWrite.then(() =>
        withManifestLock(directory, async () => {
          const manifest = await readManifest(directory);
          const metadata: ArtifactMetadata = {
            filename: input.filename,
            size: input.data.byteLength,
            ...(input.contentType === undefined
              ? {}
              : { contentType: input.contentType }),
          };
          await writeManifest(directory, {
            version: 1,
            entries: { ...manifest.entries, [filename]: metadata },
          });
        }),
      );
      metadataWrites.set(directory, metadataWrite);
      try {
        await metadataWrite;
      } finally {
        if (metadataWrites.get(directory) === metadataWrite) {
          metadataWrites.delete(directory);
        }
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
        const manifest = await readManifest(attemptDir);
        const entries = await readdir(attemptDir, { withFileTypes: true });
        for (const entry of entries
          .filter(
            (candidate) =>
              candidate.isFile() && candidate.name.startsWith("v1-"),
          )
          .sort((left, right) => left.name.localeCompare(right.name))) {
          const path = resolve(attemptDir, entry.name);
          assertContained(baseDir, path);
          const metadata = await stat(path);
          const persisted = manifest.entries[entry.name];
          refs.push(
            artifactRef(
              path,
              decodePathComponent(entry.name, "artifact filename"),
              metadata.size,
              persisted?.contentType,
            ),
          );
        }
      }
      return Object.freeze(refs);
    },
  });
}

async function withManifestLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = resolve(directory, METADATA_LOCK_FILE);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: FileHandle | undefined;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
        "utf8",
      );
      break;
    } catch (error: unknown) {
      if (!isErrnoException(error, "EEXIST")) throw error;
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError: unknown) {
        if (isErrnoException(lockError, "ENOENT")) continue;
        throw lockError;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring artifact metadata lock: ${lockPath}`,
        );
      }
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, LOCK_RETRY_MS),
      );
    }
  }

  if (handle === undefined) {
    throw new Error(`Could not acquire artifact metadata lock: ${lockPath}`);
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error: unknown) => {
      if (!isErrnoException(error, "ENOENT")) throw error;
    });
  }
}

async function readManifest(directory: string): Promise<ArtifactManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(resolve(directory, METADATA_FILE), "utf8"),
    );
  } catch (error: unknown) {
    if (isErrnoException(error, "ENOENT")) {
      return { version: 1, entries: {} };
    }
    throw new Error(`Invalid artifact metadata in ${directory}`, {
      cause: error,
    });
  }
  if (
    !isPlainObject(parsed) ||
    parsed["version"] !== 1 ||
    !isPlainObject(parsed["entries"])
  ) {
    throw new Error(`Invalid artifact metadata in ${directory}`);
  }

  const entries: Record<string, ArtifactMetadata> = {};
  for (const [name, candidate] of Object.entries(parsed["entries"])) {
    if (
      !isPlainObject(candidate) ||
      typeof candidate["filename"] !== "string" ||
      !Number.isSafeInteger(candidate["size"]) ||
      (candidate["size"] as number) < 0 ||
      (candidate["contentType"] !== undefined &&
        (typeof candidate["contentType"] !== "string" ||
          candidate["contentType"].length === 0))
    ) {
      throw new Error(
        `Invalid artifact metadata entry ${name} in ${directory}`,
      );
    }
    entries[name] = {
      filename: candidate["filename"],
      size: candidate["size"] as number,
      ...(candidate["contentType"] === undefined
        ? {}
        : { contentType: candidate["contentType"] }),
    };
  }
  return { version: 1, entries };
}

async function writeManifest(
  directory: string,
  manifest: ArtifactManifest,
): Promise<void> {
  const destination = resolve(directory, METADATA_FILE);
  const temporary = resolve(directory, `${METADATA_FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(manifest), "utf8");
  await rename(temporary, destination);
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
