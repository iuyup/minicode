import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

interface ExistingPathSegment {
  readonly target: string;
  readonly identity: BigIntStats;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatIfExists(target: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function linkError(label: string): Error {
  return new Error(`${label}经过符号链接、junction 或重解析点，拒绝使用。`);
}

/**
 * Resolves harmless aliases such as Windows 8.3 names while rejecting every
 * existing symlink, junction, or other reparse-like segment. Missing suffixes
 * are appended only after the deepest existing ancestor has been verified.
 */
export async function resolvePlainPath(target: string, label: string): Promise<string> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const existing: ExistingPathSegment[] = [];
  let cursor = root;
  let missingSegments: string[] = [];

  const rootIdentity = await fs.lstat(root, { bigint: true });
  if (rootIdentity.isSymbolicLink()) throw linkError(label);
  const followedRootIdentity = await fs.stat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || !sameFileIdentity(rootIdentity, followedRootIdentity)) {
    throw linkError(label);
  }
  existing.push({ target: root, identity: rootIdentity });

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = path.join(cursor, segments[index] ?? "");
    const identity = await lstatIfExists(candidate);
    if (!identity) {
      missingSegments = segments.slice(index);
      break;
    }
    if (identity.isSymbolicLink()) throw linkError(label);
    const followedIdentity = await fs.stat(candidate, { bigint: true });
    if (!sameFileIdentity(identity, followedIdentity)) {
      throw linkError(label);
    }
    if (index < segments.length - 1 && !followedIdentity.isDirectory()) {
      throw new Error(`${label}的既有祖先不是目录：${candidate}`);
    }
    existing.push({ target: candidate, identity });
    cursor = candidate;
  }

  const canonicalCursor = await fs.realpath(cursor);
  const canonicalIdentity = await fs.lstat(canonicalCursor, { bigint: true });
  const deepest = existing.at(-1);
  if (!deepest || !sameFileIdentity(deepest.identity, canonicalIdentity)) {
    throw new Error(`${label}的既有祖先在解析期间发生变化，拒绝使用。`);
  }

  for (const entry of existing) {
    const currentIdentity = await fs.lstat(entry.target, { bigint: true });
    if (currentIdentity.isSymbolicLink()) {
      throw new Error(`${label}的既有祖先在解析期间发生变化，拒绝使用。`);
    }
    const followedIdentity = await fs.stat(entry.target, { bigint: true });
    if (
      !sameFileIdentity(entry.identity, currentIdentity)
      || !sameFileIdentity(currentIdentity, followedIdentity)
    ) {
      throw new Error(`${label}的既有祖先在解析期间发生变化，拒绝使用。`);
    }
  }

  return path.resolve(canonicalCursor, ...missingSegments);
}
