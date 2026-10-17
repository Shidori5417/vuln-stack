/** Triggers a browser download for generated content. */
export function download(content: string | Uint8Array, filename: string, type: string): void {
  const blob = new Blob([typeof content === 'string' ? content : new Uint8Array(content)], {
    type,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
