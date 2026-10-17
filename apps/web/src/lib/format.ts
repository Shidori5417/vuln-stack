/** Deterministic (UTC) so server and client renders agree. */
export const formatDate = (d: Date | string | null | undefined): string =>
  d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
