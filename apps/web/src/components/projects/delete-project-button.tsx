'use client';

import { Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { requestJson } from '@/lib/api';

export function DeleteProjectButton({ projectId, name }: { projectId: string; name: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();

  const remove = async () => {
    if (!window.confirm(`Delete "${name}" and all of its scans? This cannot be undone.`)) return;
    try {
      await requestJson('DELETE', `/api/projects/${projectId}`);
      router.push('/dashboard');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={remove}>
        <Trash2Icon /> Delete project
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
