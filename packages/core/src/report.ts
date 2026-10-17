/** Report renderers only: JSON, SARIF and PDF (dependency-free, runs anywhere). */
export { formatJson, toJsonReport, type JsonReport } from './report/json.js';
export { formatSarif, toSarif } from './report/sarif.js';
export { renderPdfReport, type PdfReportOptions } from './report/pdf/report.js';
export type { ReportInput } from './model/types.js';
