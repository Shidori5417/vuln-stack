'use client';

import { ECOSYSTEMS, parseManualInput, type Ecosystem } from '@vulnstack/core/meta';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { fetchSuggestions, type PackageRow, type Suggestion } from '@/lib/api';

interface Props {
  rows: PackageRow[];
  onChange: (rows: PackageRow[]) => void;
}

/** Name input with registry suggestions (debounced) in a native datalist. */
function NameInput({
  row,
  onChange,
}: {
  row: PackageRow;
  onChange: (name: string, version?: string) => void;
}) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    if (row.name.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSuggestions(row.ecosystem, row.name, controller.signal).then(setSuggestions, () => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [row.ecosystem, row.name]);

  return (
    <>
      <Input
        aria-label="Package name"
        list={listId}
        value={row.name}
        placeholder="package name"
        onChange={(e) => {
          const picked = suggestions.find((s) => s.name === e.target.value);
          onChange(e.target.value, !row.version && picked?.version ? picked.version : undefined);
        }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.name} value={s.name}>
            {s.version ? `${s.version} — ` : ''}
            {s.description ?? ''}
          </option>
        ))}
      </datalist>
    </>
  );
}

export function ManualEntry({ rows, onChange }: Props) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const addFromText = () => {
    const { entries, errors: bad } = parseManualInput(text);
    onChange([
      ...rows,
      ...entries.map((e) => ({ ecosystem: e.ecosystem, name: e.name, version: e.version })),
    ]);
    setErrors(bad.map((b) => b.raw));
    if (bad.length === 0) setText('');
  };

  const update = (i: number, patch: Partial<PackageRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Textarea
          aria-label="Package list"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addFromText();
          }}
          placeholder={
            'react 18.2.0, express@4.17.1\ndjango==4.1\norg.apache.logging.log4j:log4j-core:2.14.1'
          }
          className="font-mono text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Comma or newline separated. Prefix with <code>pypi:</code>, <code>go:</code>,{' '}
            <code>maven:</code>… to force an ecosystem — or fix it below.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addFromText}
            disabled={!text.trim()}
          >
            <PlusIcon /> Add to list
          </Button>
        </div>
        {errors.length > 0 && (
          <p className="text-xs text-destructive">Could not read: {errors.join(', ')}</p>
        )}
      </div>

      {rows.length > 0 && (
        <div className="space-y-2" role="list" aria-label="Packages to scan">
          {rows.map((row, i) => (
            <div
              key={i}
              role="listitem"
              className="grid grid-cols-[7.5rem_1fr_7rem_auto] items-center gap-2 max-sm:grid-cols-[1fr_auto] max-sm:rounded-lg max-sm:border max-sm:p-2"
            >
              <NativeSelect
                aria-label="Ecosystem"
                value={row.ecosystem}
                onChange={(e) => update(i, { ecosystem: e.target.value as Ecosystem })}
              >
                {ECOSYSTEMS.map((eco) => (
                  <option key={eco} value={eco}>
                    {eco}
                  </option>
                ))}
              </NativeSelect>
              <div className="max-sm:col-span-2 max-sm:row-start-2">
                <NameInput
                  row={row}
                  onChange={(name, version) => update(i, { name, ...(version ? { version } : {}) })}
                />
              </div>
              <Input
                aria-label="Version"
                value={row.version}
                placeholder="latest"
                onChange={(e) => update(i, { version: e.target.value })}
                className="max-sm:col-span-2 max-sm:row-start-3"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${row.name || 'row'}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="max-sm:col-start-2 max-sm:row-start-1"
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange([
                ...rows,
                { ecosystem: rows.at(-1)?.ecosystem ?? 'npm', name: '', version: '' },
              ])
            }
          >
            <PlusIcon /> Add row
          </Button>
        </div>
      )}
    </div>
  );
}
