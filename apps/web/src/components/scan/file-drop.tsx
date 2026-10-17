'use client';

import { FileIcon, FolderOpenIcon, UploadIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  acceptFiles,
  formatBytes,
  readDataTransfer,
  readFileList,
  type UploadFile,
} from '@/lib/files';
import { cn } from '@/lib/utils';

interface Props {
  files: UploadFile[];
  onChange: (files: UploadFile[]) => void;
  maxBytes: number;
}

export function FileDrop({ files, onChange, maxBytes }: Props) {
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const add = (incoming: UploadFile[], skipped: string[] = []) => {
    const { accepted, rejected: notSupported } = acceptFiles([...files, ...incoming]);
    onChange(accepted);
    setRejected([...skipped, ...notSupported]);
  };

  const total = files.reduce((n, f) => n + f.size, 0);

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop dependency files or folders here, or press Enter to choose files"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click();
        }}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          add(await readDataTransfer(e.dataTransfer.items));
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          dragging ? 'border-primary bg-accent' : 'hover:bg-accent/50',
        )}
      >
        <UploadIcon className="size-8 text-muted-foreground" aria-hidden />
        <p className="font-medium">Drop lock files, manifests or a whole project folder</p>
        <p className="text-sm text-muted-foreground">
          package-lock.json, pnpm-lock.yaml, yarn.lock, poetry.lock, uv.lock, requirements.txt,
          composer.lock, pom.xml, gradle.lockfile, go.mod, packages.lock.json, *.csproj…
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInput.current?.click()}
        >
          <FileIcon /> Choose files
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => folderInput.current?.click()}
        >
          <FolderOpenIcon /> Choose folder
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={async (e) => {
            if (e.target.files) add(await readFileList(e.target.files));
            e.target.value = '';
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          // @ts-expect-error non-standard but widely supported attribute
          webkitdirectory=""
          onChange={async (e) => {
            if (e.target.files) add(await readFileList(e.target.files));
            e.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm" aria-label="Selected files">
          {files.map((f) => (
            <li key={f.path} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="truncate font-mono text-xs">{f.path}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {formatBytes(f.size)}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Remove ${f.path}`}
                  onClick={() => onChange(files.filter((x) => x.path !== f.path))}
                >
                  <XIcon />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <p
          className={cn('text-xs', total > maxBytes ? 'text-destructive' : 'text-muted-foreground')}
        >
          {files.length} file{files.length === 1 ? '' : 's'}, {formatBytes(total)}
          {total > maxBytes &&
            ` — over the ${formatBytes(maxBytes)} limit; use the CLI for large projects`}
        </p>
      )}
      {rejected.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Skipped {rejected.length} unsupported file{rejected.length === 1 ? '' : 's'}:{' '}
          {rejected.slice(0, 3).join(', ')}
          {rejected.length > 3 ? '…' : ''}
        </p>
      )}
    </div>
  );
}
