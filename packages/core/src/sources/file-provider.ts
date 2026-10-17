/**
 * Read-only view of a file tree. Local folders, GitHub repos and browser
 * uploads all implement this, so parsers never touch the file system directly.
 * Paths are POSIX-style and relative to the provider root.
 */
export interface FileProvider {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
}

export class MemoryFileProvider implements FileProvider {
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string> | Map<string, string>) {
    this.files = files instanceof Map ? new Map(files) : new Map(Object.entries(files));
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
