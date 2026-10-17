import { ALL_SUPPORTED_PATTERNS, matchesAny } from '@vulnstack/core/meta';

export interface UploadFile {
  path: string;
  content: string;
  size: number;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
]);

export const isSupportedFile = (name: string) => matchesAny(ALL_SUPPORTED_PATTERNS, name);

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Keeps supported files only and de-duplicates by path (last one wins). */
export function acceptFiles(files: UploadFile[]): { accepted: UploadFile[]; rejected: string[] } {
  const accepted = new Map<string, UploadFile>();
  const rejected: string[] = [];
  for (const f of files) {
    if (f.path.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    if (isSupportedFile(baseName(f.path))) accepted.set(f.path, f);
    else rejected.push(f.path);
  }
  return {
    accepted: [...accepted.values()].sort((a, b) => a.path.localeCompare(b.path)),
    rejected,
  };
}

async function readFile(file: File, path: string): Promise<UploadFile> {
  return { path, content: await file.text(), size: file.size };
}

/** Minimal shape of the File System Entries API used by drag & drop. */
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(cb: (entries: Entry[]) => void, err: (e: unknown) => void): void };
}

async function walkEntry(entry: Entry, out: UploadFile[], depth = 0): Promise<void> {
  if (depth > 12) return;
  if (entry.isFile && entry.file) {
    if (!isSupportedFile(entry.name)) return;
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    out.push(await readFile(file, entry.fullPath.replace(/^\//, '')));
  } else if (entry.isDirectory && entry.createReader && !SKIP_DIRS.has(entry.name)) {
    const reader = entry.createReader();
    // readEntries returns results in batches until it yields an empty list.
    for (;;) {
      const batch = await new Promise<Entry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, out, depth + 1);
    }
  }
}

/** Reads dropped files and folders, keeping relative paths for monorepos. */
export async function readDataTransfer(items: DataTransferItemList): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  const entries = Array.from(items)
    .map((item) => (item.webkitGetAsEntry?.() as Entry | null) ?? null)
    .filter((e): e is Entry => e !== null);
  for (const entry of entries) await walkEntry(entry, out);
  return out;
}

/** Reads files from an <input type=file> (with webkitdirectory, paths are relative). */
export async function readFileList(list: FileList | File[]): Promise<UploadFile[]> {
  const files = Array.from(list).filter((f) => isSupportedFile(f.name));
  return Promise.all(
    files.map((f) =>
      readFile(f, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name),
    ),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
