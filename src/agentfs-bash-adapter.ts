import path from "node:path";
import type {
  BufferEncoding,
  CpOptions,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { AgentFS } from "agentfs-sdk/cloudflare";

export class AgentFsBashAdapter implements IFileSystem {
  constructor(private readonly fs: AgentFS) {}

  async readFile(
    targetPath: string,
    options?: { encoding?: BufferEncoding | null } | BufferEncoding,
  ): Promise<string> {
    const encoding =
      typeof options === "string" ? options : options?.encoding ?? "utf8";
    return this.fs.readFile(normalizePath(targetPath), encoding ?? "utf8");
  }

  async readFileBuffer(targetPath: string): Promise<Uint8Array> {
    return this.fs.readFile(normalizePath(targetPath));
  }

  async writeFile(
    targetPath: string,
    content: string | Uint8Array,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const encoding =
      typeof options === "string" ? options : options?.encoding ?? "utf8";
    const normalizedPath = normalizePath(targetPath);

    await this.ensureParentDirectories(normalizedPath);
    await this.fs.writeFile(
      normalizedPath,
      typeof content === "string" ? content : Buffer.from(content),
      encoding,
    );
  }

  async appendFile(
    targetPath: string,
    content: string | Uint8Array,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const normalizedPath = normalizePath(targetPath);
    const encoding =
      typeof options === "string" ? options : options?.encoding ?? "utf8";

    let existing = "";
    if (await this.exists(normalizedPath)) {
      existing = await this.fs.readFile(normalizedPath, encoding);
    }

    const nextContent =
      existing + (typeof content === "string" ? content : Buffer.from(content).toString(encoding));
    await this.writeFile(normalizedPath, nextContent, encoding);
  }

  async exists(targetPath: string): Promise<boolean> {
    try {
      await this.fs.access(normalizePath(targetPath));
      return true;
    } catch {
      return false;
    }
  }

  async stat(targetPath: string): Promise<FsStat> {
    return toFsStat(await this.fs.stat(normalizePath(targetPath)));
  }

  async lstat(targetPath: string): Promise<FsStat> {
    return toFsStat(await this.fs.lstat(normalizePath(targetPath)));
  }

  async mkdir(targetPath: string, options?: MkdirOptions): Promise<void> {
    const normalizedPath = normalizePath(targetPath);
    if (options?.recursive) {
      await this.ensureParentDirectories(path.posix.join(normalizedPath, "child"));
      if (!(await this.exists(normalizedPath))) {
        await this.fs.mkdir(normalizedPath);
      }
      return;
    }

    await this.fs.mkdir(normalizedPath);
  }

  async readdir(targetPath: string): Promise<string[]> {
    return this.fs.readdir(normalizePath(targetPath));
  }

  async rm(targetPath: string, options?: RmOptions): Promise<void> {
    await this.fs.rm(normalizePath(targetPath), options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const sourcePath = normalizePath(src);
    const destinationPath = normalizePath(dest);
    const sourceStats = await this.fs.stat(sourcePath);

    if (sourceStats.isDirectory()) {
      if (!options?.recursive) {
        throw new Error("recursive copy required for directories");
      }
      await this.copyDirectory(sourcePath, destinationPath);
      return;
    }

    await this.ensureParentDirectories(destinationPath);
    await this.fs.copyFile(sourcePath, destinationPath);
  }

  async mv(src: string, dest: string): Promise<void> {
    const destinationPath = normalizePath(dest);
    await this.ensureParentDirectories(destinationPath);
    await this.fs.rename(normalizePath(src), destinationPath);
  }

  resolvePath(base: string, targetPath: string): string {
    return normalizePath(path.posix.resolve(base, targetPath));
  }

  getAllPaths(): string[] {
    return [];
  }

  async chmod(_targetPath: string, _mode: number): Promise<void> {}

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalizedLink = normalizePath(linkPath);
    await this.ensureParentDirectories(normalizedLink);
    await this.fs.symlink(target, normalizedLink);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.cp(existingPath, newPath);
  }

  async readlink(targetPath: string): Promise<string> {
    return this.fs.readlink(normalizePath(targetPath));
  }

  async realpath(targetPath: string): Promise<string> {
    return normalizePath(targetPath);
  }

  async utimes(targetPath: string, _atime: Date, _mtime: Date): Promise<void> {
    if (!(await this.exists(targetPath))) {
      throw new Error(`ENOENT: no such file or directory, utime '${targetPath}'`);
    }
  }

  private async ensureParentDirectories(targetPath: string): Promise<void> {
    const parent = path.posix.dirname(normalizePath(targetPath));
    if (parent === "/" || parent === ".") {
      return;
    }

    const segments = parent.split("/").filter(Boolean);
    let current = "";

    for (const segment of segments) {
      current += `/${segment}`;
      if (!(await this.exists(current))) {
        await this.fs.mkdir(current);
      }
    }
  }

  private async copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
    await this.mkdir(destinationPath, { recursive: true });

    const entries = await this.fs.readdirPlus(sourcePath);
    for (const entry of entries) {
      const nextSource = path.posix.join(sourcePath, entry.name);
      const nextDestination = path.posix.join(destinationPath, entry.name);

      if (entry.stats.isDirectory()) {
        await this.copyDirectory(nextSource, nextDestination);
      } else if (entry.stats.isSymbolicLink()) {
        await this.symlink(await this.fs.readlink(nextSource), nextDestination);
      } else {
        await this.fs.copyFile(nextSource, nextDestination);
      }
    }
  }
}

function normalizePath(targetPath: string): string {
  const normalized = path.posix.normalize(targetPath);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function toFsStat(stats: Awaited<ReturnType<AgentFS["stat"]>>): FsStat {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    mode: stats.mode,
    size: stats.size,
    mtime: new Date(stats.mtime),
  };
}
