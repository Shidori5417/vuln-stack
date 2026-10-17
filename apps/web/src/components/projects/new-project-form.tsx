'use client';

import { Loader2Icon, PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { requestJson } from '@/lib/api';

export function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState('files');
  const [sourceRef, setSourceRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const project = await requestJson<{ id: string }>('POST', '/api/projects', {
        name,
        sourceType,
        ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
      });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr]">
        <div className="space-y-1">
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-app"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="project-type">Source</Label>
          <NativeSelect
            id="project-type"
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value)}
          >
            <option value="files">Uploaded files</option>
            <option value="manual">Manual list</option>
            <option value="repo">Repository</option>
            <option value="url">Website</option>
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="project-ref">Reference (optional)</Label>
          <Input
            id="project-ref"
            maxLength={500}
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            placeholder="https://github.com/org/repo"
          />
        </div>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />} Create project
      </Button>
    </form>
  );
}
