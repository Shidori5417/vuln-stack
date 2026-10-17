'use client';

import { GitCompareIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label, NativeSelect } from '@/components/ui/input';

export interface PickerScan {
  id: string;
  label: string;
}

/** `scans` is newest first; by default compare the previous scan with the latest. */
export function ComparePicker({ projectId, scans }: { projectId: string; scans: PickerScan[] }) {
  const router = useRouter();
  const [base, setBase] = useState(scans[1]?.id ?? '');
  const [head, setHead] = useState(scans[0]?.id ?? '');
  if (scans.length < 2) return null;

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/projects/${projectId}/compare?base=${base}&head=${head}`);
      }}
    >
      {(
        [
          ['Base (older)', base, setBase],
          ['Head (newer)', head, setHead],
        ] as const
      ).map(([label, value, set]) => (
        <div key={label} className="min-w-48 flex-1 space-y-1">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          <NativeSelect aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
            {scans.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      <Button type="submit" variant="outline" disabled={!base || !head || base === head}>
        <GitCompareIcon /> Compare
      </Button>
    </form>
  );
}
