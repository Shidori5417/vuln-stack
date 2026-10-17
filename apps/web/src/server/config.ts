/** Runtime settings from the environment, read once per process. */
export interface ServerConfig {
  maxUploadBytes: number;
  maxFiles: number;
  scansPerMinute: number;
  trustProxy: boolean;
  githubToken?: string;
  nvdApiKey?: string;
  scanTimeoutMs: number;
  /** CISA KEV / FIRST EPSS enrichment; disable with VULNSTACK_KEV=0 / VULNSTACK_EPSS=0. */
  kev: boolean;
  epss: boolean;
}

const int = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const config: ServerConfig = {
    maxUploadBytes: int(env.VULNSTACK_MAX_UPLOAD_MB, 10) * 1024 * 1024,
    maxFiles: int(env.VULNSTACK_MAX_FILES, 200),
    scansPerMinute: int(env.VULNSTACK_SCANS_PER_MINUTE, 10),
    trustProxy: env.VULNSTACK_TRUST_PROXY === '1',
    scanTimeoutMs: int(env.VULNSTACK_SCAN_TIMEOUT_MS, 55_000),
    kev: env.VULNSTACK_KEV !== '0',
    epss: env.VULNSTACK_EPSS !== '0',
  };
  if (env.GITHUB_TOKEN) config.githubToken = env.GITHUB_TOKEN;
  if (env.NVD_API_KEY) config.nvdApiKey = env.NVD_API_KEY;
  return config;
}
