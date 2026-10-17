import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Cvss, Reference, ScanSummary, Warning } from '@vulnstack/core';

// ---------------------------------------------------------------------------
// Better Auth core tables (names and columns as Better Auth expects them)
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

/** OAuth accounts. Tokens are encrypted by Better Auth (`account.encryptOAuthTokens`). */
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// VulnStack
// ---------------------------------------------------------------------------

export const sourceType = pgEnum('source_type', ['repo', 'url', 'files', 'manual', 'cli']);
export const scanStatus = pgEnum('scan_status', ['queued', 'running', 'done', 'failed']);
export const scanTrigger = pgEnum('scan_trigger', ['web', 'cli', 'api']);
export const triageStatus = pgEnum('triage_status', ['accepted', 'false_positive']);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sourceType: sourceType('source_type').notNull(),
    /** Repo URL, site URL, or a free-form label for uploads. */
    sourceRef: text('source_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_owner_name_idx').on(t.ownerId, t.name)],
);

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: scanStatus('status').notNull().default('queued'),
    trigger: scanTrigger('trigger').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    summary: jsonb('summary').$type<ScanSummary>(),
    warnings: jsonb('warnings')
      .$type<Warning[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    error: text('error'),
    toolVersion: text('tool_version'),
  },
  (t) => [index('scans_project_started_idx').on(t.projectId, t.startedAt)],
);

/** Every dependency seen in a scan; raw file contents are never stored. */
export const scanDependencies = pgTable(
  'scan_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    subproject: text('subproject').notNull(),
    ecosystem: text('ecosystem').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    isDirect: boolean('is_direct').notNull(),
    confidence: text('confidence').notNull(),
    scope: text('scope'),
    sourceFile: text('source_file').notNull(),
  },
  (t) => [index('scan_dependencies_scan_idx').on(t.scanId)],
);

/** Merged advisory data, shared across scans and refreshed on every save. */
export const vulnerabilities = pgTable('vulnerabilities', {
  id: text('id').primaryKey(),
  aliases: text('aliases').array().notNull(),
  summary: text('summary').notNull(),
  details: text('details'),
  severity: text('severity').notNull(),
  cvss: jsonb('cvss').$type<Cvss>(),
  published: text('published'),
  modified: text('modified'),
  references: jsonb('references').$type<Reference[]>().notNull(),
  cwes: text('cwes').array().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    /** subproject|ecosystem|package|vulnerability — stable across scans. */
    fingerprint: text('fingerprint').notNull(),
    subproject: text('subproject').notNull(),
    ecosystem: text('ecosystem').notNull(),
    packageName: text('package_name').notNull(),
    version: text('version').notNull(),
    isDirect: boolean('is_direct').notNull(),
    scope: text('scope'),
    confidence: text('confidence').notNull(),
    declaredRange: text('declared_range'),
    sourceFile: text('source_file').notNull(),
    chain: text('chain').array().notNull(),
    pathCount: integer('path_count').notNull(),
    vulnId: text('vuln_id')
      .notNull()
      .references(() => vulnerabilities.id),
    severity: text('severity').notNull(),
    cvssScore: real('cvss_score'),
    /** Score as of this scan, so history doesn't shift when advisories are rescored. */
    cvss: jsonb('cvss').$type<Cvss>(),
    fixType: text('fix_type').notNull(),
    fixedVersion: text('fixed_version'),
  },
  (t) => [
    index('findings_scan_idx').on(t.scanId),
    index('findings_fingerprint_idx').on(t.fingerprint),
  ],
);

/** Triage outlives scans: keyed by project + fingerprint, not by finding row. */
export const findingTriage = pgTable(
  'finding_triage',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    status: triageStatus('status').notNull(),
    note: text('note'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.fingerprint] })],
);

/** CacheStore backing for advisory lookups when Redis isn't configured. */
export const vulnCache = pgTable(
  'vuln_cache',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('vuln_cache_expires_idx').on(t.expiresAt)],
);

/** Personal API tokens for the CLI. Only a SHA-256 hash is stored. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** First characters, shown in the UI to tell tokens apart. */
    prefix: text('prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
);

export const projectsRelations = relations(projects, ({ many, one }) => ({
  owner: one(user, { fields: [projects.ownerId], references: [user.id] }),
  scans: many(scans),
  triage: many(findingTriage),
}));

export const scansRelations = relations(scans, ({ one, many }) => ({
  project: one(projects, { fields: [scans.projectId], references: [projects.id] }),
  findings: many(findings),
  dependencies: many(scanDependencies),
}));

export const findingsRelations = relations(findings, ({ one }) => ({
  scan: one(scans, { fields: [findings.scanId], references: [scans.id] }),
  vulnerability: one(vulnerabilities, {
    fields: [findings.vulnId],
    references: [vulnerabilities.id],
  }),
}));

export const scanDependenciesRelations = relations(scanDependencies, ({ one }) => ({
  scan: one(scans, { fields: [scanDependencies.scanId], references: [scans.id] }),
}));

export const findingTriageRelations = relations(findingTriage, ({ one }) => ({
  project: one(projects, { fields: [findingTriage.projectId], references: [projects.id] }),
}));
