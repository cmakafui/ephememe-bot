import path from "node:path";

export const MEMORY_ROOT = "/memory";

export function normalizeMemoryPath(targetPath: string): string {
  const normalized = path.posix.normalize(
    targetPath.trim() === "" ? MEMORY_ROOT : targetPath.trim(),
  );

  if (normalized !== MEMORY_ROOT && !normalized.startsWith(`${MEMORY_ROOT}/`)) {
    throw new Error("path must stay under /memory");
  }

  return normalized;
}

export function resolveWorkspacePath(targetPath: string): string {
  const resolved = path.posix.resolve(MEMORY_ROOT, targetPath);
  return normalizeMemoryPath(resolved);
}
