/**
 * Per-project loop config: `.github/loop-config.json`, committed INSIDE each
 * target repo (not the dashboard's own repo) — mirrors lib/map-power.ts's
 * "read/write a small JSON file on a target repo via the Contents API"
 * pattern. The target repos' own workflows read this file at runtime with a
 * `jq ... // default` fallback, so a missing file is always safe: it just
 * means "use the defaults below."
 */

import { createHash } from "node:crypto";
import { getFileWithSha, commitFile, type RepoConfig } from "./github";
import { MODEL_AGENT_IDS, MODEL_CHOICES, isModelChoice, type AgentModels } from "./loop-models";

export const LOOP_CONFIG_PATH = ".github/loop-config.json";

/**
 * Opt-in reconciliation of the approved queue against the code that has landed
 * since. Off by default and stored inside the `scout` block because the Scout
 * workflow owns it: `claude-scout.yml` has the only live cron, so the check is
 * a gate inside that hourly run rather than a schedule of its own.
 *
 * Both fields have `jq ... // default` fallbacks in the workflow, so an absent
 * `staleCheck` key means "off" — which is why {@link serializeLoopConfig}
 * omits it entirely while it is at its default.
 */
export type StaleCheckConfig = {
  /**
   * Whether the Scout run may reconcile `approved` ideas against `main` at
   * all. False by default: this posts comments on the owner's issues, and no
   * feature that writes to a repo turns itself on.
   */
  enabled: boolean;
  /**
   * Minimum hours between two checks. The Scout cron fires hourly, so this is
   * a gate inside that run, not a schedule — see `isStaleCheckDue` in
   * lib/idea-staleness.ts.
   */
  intervalHours: number;
};

/**
 * The per-repo scouting brief. Read by the Scout workflow (same
 * `jq ... // default` pattern as the caps) so it proposes ideas for THIS
 * product rather than software in general. Every field is optional in
 * practice — an empty brief just means "no extra steer".
 */
export type ScoutConfig = {
  /** One paragraph: what this product is and who it's for. */
  productSummary: string;
  /** What matters right now — the Scout should aim ideas at these. */
  currentGoals: string[];
  /** Areas the Scout must not propose work on. */
  offLimits: string[];
  /** The angles the Scout researches from (rotated per run). */
  lenses: string[];
  /** Hard cap on how many ideas a single Scout run may file. */
  maxPerRun: number;
  /** Opt-in staleness reconciliation for the `approved` queue. */
  staleCheck: StaleCheckConfig;
  /**
   * The same "keep what we don't recognise" contract as {@link LoopConfig.extra},
   * one level down.
   *
   * This block needed its own copy because `normalizeScout` rebuilds the object
   * from named fields, so anything else inside `scout` was silently dropped on
   * save — and `claude-scout.yml` already reads a key the dashboard has never
   * modelled (`scout.aiProvider`, which chooses subscription vs Bedrock). Saving
   * the brief from the Ideas page was therefore enough to switch a repo's Scout
   * off Bedrock without anyone touching that setting. Never settable over the
   * wire: it only ever comes from disk.
   */
  extra?: Record<string, unknown>;
};

export type LoopConfig = {
  autonomousBuildEnabled: boolean;
  prCap: number | "unlimited";
  ideaQueueCap: number | "unlimited";
  /**
   * Local port the demo workflow's app runs on when it starts up, for the
   * demo-recording step. Optional — the workflow's own `jq ... // 3000`
   * fallback covers an absent/undefined value, so this must stay unset
   * unless the owner has explicitly typed a port.
   */
  demoPort?: number;
  /**
   * The model each agent runs on, keyed by Process Map agent id - see
   * lib/loop-models.ts. Absent means every agent runs on the default, and
   * a key only ever appears once the owner has picked something, so an
   * untouched repo's file never gains it.
   *
   * Kept as read, unknown keys and values included: the workflows ignore a
   * value they don't recognise, and dropping it on an unrelated save would
   * delete a setting a newer workflow may understand.
   */
  models?: AgentModels;
  scout: ScoutConfig;
  /**
   * Everything in the stored file that this version of the dashboard doesn't
   * know about, kept verbatim and written back out on every save.
   *
   * Without it, saving from the dashboard silently DELETED any key a newer
   * workflow (or a hand edit) had added — the config is read by the target
   * repo's own workflows, so a dropped key is a setting that quietly stops
   * applying. Never settable through the API: it only ever comes from what was
   * on disk.
   */
  extra?: Record<string, unknown>;
};

/** The keys this file owns. Anything else in the JSON is preserved as `extra`. */
const CANONICAL_KEYS = [
  "autonomousBuildEnabled",
  "prCap",
  "ideaQueueCap",
  "demoPort",
  "models",
  "scout",
] as const;

/** Same idea, one level down — see {@link ScoutConfig.extra}. */
const SCOUT_CANONICAL_KEYS = [
  "productSummary",
  "currentGoals",
  "offLimits",
  "lenses",
  "maxPerRun",
  "staleCheck",
] as const;

/** Off, and daily when it is switched on. Both halves matter — see below. */
export const DEFAULT_STALE_CHECK_CONFIG: StaleCheckConfig = {
  enabled: false,
  intervalHours: 24,
};

/** The intervals the settings panel offers. Any 1–168 value is still accepted. */
export const STALE_CHECK_INTERVAL_CHOICES = [1, 6, 24] as const;

/** Bounds for `scout.staleCheck.intervalHours` — an hour to a week. */
export const MIN_STALE_INTERVAL_HOURS = 1;
export const MAX_STALE_INTERVAL_HOURS = 168;

export const DEFAULT_SCOUT_CONFIG: ScoutConfig = {
  productSummary: "",
  currentGoals: [],
  offLimits: [],
  lenses: [],
  maxPerRun: 3,
  staleCheck: { ...DEFAULT_STALE_CHECK_CONFIG },
};

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  autonomousBuildEnabled: false,
  prCap: 3,
  ideaQueueCap: 25,
  scout: { ...DEFAULT_SCOUT_CONFIG },
};

/** Upper bound for `scout.maxPerRun` (matches the UI's number input). */
export const MAX_IDEAS_PER_RUN = 10;

/** Error carrying the HTTP status a route should surface for it. */
export class LoopConfigError extends Error {
  constructor(
    message: string,
    public httpStatus: number = 400,
  ) {
    super(message);
    this.name = "LoopConfigError";
  }
}

/**
 * Someone else saved this project's config between the read the caller based
 * its edit on and this write. Carries the current config so the caller can
 * hand it straight back to the UI without a second round trip.
 */
export class LoopConfigConflictError extends LoopConfigError {
  constructor(
    public config: LoopConfig,
    public fingerprint: string,
  ) {
    super(
      "These settings were changed somewhere else while you were editing.",
      409,
    );
    this.name = "LoopConfigConflictError";
  }
}

/* ------------------------------------------------------------------ */
/* Read-time normalization                                             */
/* ------------------------------------------------------------------ */

function normalizeCap(value: unknown, fallback: number | "unlimited") {
  if (value === "unlimited") return "unlimited" as const;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return fallback;
}

/**
 * Unlike `normalizeCap`, there is no fallback here: a missing or invalid
 * `demoPort` must stay `undefined`, not silently become 3000. The demo
 * workflow's own `// 3000` fallback is what supplies the default at run
 * time, same contract as the rest of this file's `jq ... // default` reads.
 */
function normalizeDemoPort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value;
  }
  return undefined;
}

/**
 * Only string values survive: they are all a workflow can use, and anything
 * else is ignored by the workflow's own `strings` filter too. Unknown keys and
 * unknown model names are kept (see LoopConfig.models); a `models` that is not
 * an object at all reads as "nothing picked".
 */
function normalizeModels(value: unknown): AgentModels | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const models: AgentModels = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string" && v !== "") models[key] = v;
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * A missing / malformed `staleCheck` is "off", never a crash and never on.
 * `intervalHours` is clamped rather than rejected so a hand-edited `0` (which
 * would mean "re-check every single hourly Scout run") lands on the floor
 * instead of dividing the gate by zero.
 */
function normalizeStaleCheck(value: unknown): StaleCheckConfig {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const intervalHours =
    typeof raw.intervalHours === "number" && Number.isInteger(raw.intervalHours)
      ? Math.min(MAX_STALE_INTERVAL_HOURS, Math.max(MIN_STALE_INTERVAL_HOURS, raw.intervalHours))
      : DEFAULT_STALE_CHECK_CONFIG.intervalHours;
  return {
    enabled: raw.enabled === true,
    intervalHours,
  };
}

function normalizeScout(value: unknown): ScoutConfig {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const maxPerRun =
    typeof raw.maxPerRun === "number" && Number.isInteger(raw.maxPerRun)
      ? Math.min(MAX_IDEAS_PER_RUN, Math.max(1, raw.maxPerRun))
      : DEFAULT_SCOUT_CONFIG.maxPerRun;

  // Anything inside `scout` this version doesn't model — `aiProvider` today —
  // rides along verbatim instead of being deleted by the next save.
  const extra: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw)) {
    if ((SCOUT_CANONICAL_KEYS as readonly string[]).includes(key)) continue;
    extra[key] = v;
  }

  const scout: ScoutConfig = {
    productSummary:
      typeof raw.productSummary === "string" ? raw.productSummary.trim() : "",
    currentGoals: normalizeStringList(raw.currentGoals),
    offLimits: normalizeStringList(raw.offLimits),
    lenses: normalizeStringList(raw.lenses),
    maxPerRun,
    staleCheck: normalizeStaleCheck(raw.staleCheck),
  };
  if (Object.keys(extra).length > 0) scout.extra = extra;
  return scout;
}

/**
 * Coerce anything that may be sitting in the persisted file into a valid
 * config. A hand-edited or half-migrated `loop-config.json` must never crash
 * a consumer — malformed values fall back to the defaults, same contract as
 * the workflows' `jq ... // default` reads.
 */
export function normalizeLoopConfig(value: unknown): LoopConfig {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;

  // Keep whatever we don't recognise so a save round-trips it instead of
  // deleting it (see LoopConfig.extra).
  const extra: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw)) {
    if ((CANONICAL_KEYS as readonly string[]).includes(key)) continue;
    extra[key] = v;
  }

  const config: LoopConfig = {
    autonomousBuildEnabled:
      typeof raw.autonomousBuildEnabled === "boolean"
        ? raw.autonomousBuildEnabled
        : DEFAULT_LOOP_CONFIG.autonomousBuildEnabled,
    prCap: normalizeCap(raw.prCap, DEFAULT_LOOP_CONFIG.prCap),
    ideaQueueCap: normalizeCap(raw.ideaQueueCap, DEFAULT_LOOP_CONFIG.ideaQueueCap),
    demoPort: normalizeDemoPort(raw.demoPort),
    models: normalizeModels(raw.models),
    scout: normalizeScout(raw.scout),
  };
  if (Object.keys(extra).length > 0) config.extra = extra;
  return config;
}

/**
 * `undefined` (so JSON.stringify drops the key) whenever the block is at its
 * default, otherwise the block itself. A non-default interval survives being
 * switched off, so re-enabling doesn't silently reset it to daily.
 */
function serializableStaleCheck(
  staleCheck: StaleCheckConfig,
): StaleCheckConfig | undefined {
  if (
    !staleCheck.enabled &&
    staleCheck.intervalHours === DEFAULT_STALE_CHECK_CONFIG.intervalHours
  ) {
    return undefined;
  }
  return { enabled: staleCheck.enabled, intervalHours: staleCheck.intervalHours };
}

/**
 * Canonical on-disk form — stable key order, so fingerprints are stable.
 *
 * Unrecognised keys are written first (in the order they were read), then the
 * keys this file owns, so a canonical key can never be shadowed by a stale
 * copy sitting in `extra`.
 */
export function serializeLoopConfig(config: LoopConfig): string {
  return (
    JSON.stringify(
      {
        ...(config.extra ?? {}),
        autonomousBuildEnabled: config.autonomousBuildEnabled,
        prCap: config.prCap,
        ideaQueueCap: config.ideaQueueCap,
        // Omitted entirely when unset — JSON.stringify drops undefined-
        // valued keys, so an absent demoPort round-trips as absent.
        demoPort: config.demoPort,
        // Same omit-when-unset rule: nothing picked writes no key at all.
        models:
          config.models && Object.keys(config.models).length > 0 ? config.models : undefined,
        scout: {
          ...(config.scout.extra ?? {}),
          productSummary: config.scout.productSummary,
          currentGoals: config.scout.currentGoals,
          offLimits: config.scout.offLimits,
          lenses: config.scout.lenses,
          maxPerRun: config.scout.maxPerRun,
          // Same omit-when-it-means-nothing rule as demoPort above: while the
          // check is off AND on the default interval the key carries no
          // information the workflow's `// false` fallback doesn't already
          // supply, so leaving it out keeps an untouched repo's config
          // byte-identical to what it was before this feature existed.
          staleCheck: serializableStaleCheck(config.scout.staleCheck),
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * A short hash of the config as it would be stored. Used for optimistic
 * concurrency: the UI sends back the fingerprint it loaded, and a save is
 * rejected (409) if the stored config has moved on since.
 *
 * It hashes the FULL serialization, unrecognised keys included, so a
 * concurrent change to a key this version doesn't know about still conflicts
 * rather than being quietly overwritten.
 */
export function loopConfigFingerprint(config: LoopConfig): string {
  return createHash("sha256")
    .update(serializeLoopConfig(config))
    .digest("hex")
    .slice(0, 16);
}

function parseLoopConfig(raw: string | null): LoopConfig | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return normalizeLoopConfig(parsed);
  } catch {
    return null;
  }
}

function defaultConfig(): LoopConfig {
  return {
    ...DEFAULT_LOOP_CONFIG,
    scout: { ...DEFAULT_SCOUT_CONFIG, staleCheck: { ...DEFAULT_STALE_CHECK_CONFIG } },
  };
}

/**
 * A project's loop config plus the blob sha it was read from (`null` when the
 * file doesn't exist yet). The sha is what {@link setLoopConfig} hands to
 * `commitFile` so the save is checked against the exact bytes it read.
 *
 * A MISSING file falls back to {@link DEFAULT_LOOP_CONFIG} — same contract as
 * the target repos' own `jq ... // default` reads. A failed read (403 rate
 * limit, 5xx, network) THROWS. It used to return the defaults, which looked
 * harmless on a GET but was destructive on a save: two phantom default reads
 * fingerprint-match each other, so the save sailed through the conflict check
 * and overwrote the owner's real settings with defaults.
 */
export async function readLoopConfig(
  repo: RepoConfig,
): Promise<{ config: LoopConfig; sha: string | null }> {
  const found = await getFileWithSha(LOOP_CONFIG_PATH, undefined, repo);
  if (!found) return { config: defaultConfig(), sha: null };
  // Unparsable content is still a real file: keep its sha so a save replaces
  // it (rather than trying to create a file that already exists).
  return { config: parseLoopConfig(found.content) ?? defaultConfig(), sha: found.sha };
}

/**
 * Read a project's loop config. A missing or unparsable file falls back to
 * {@link DEFAULT_LOOP_CONFIG}; a failed read throws (routes map it to a 502).
 */
export async function getLoopConfig(repo: RepoConfig): Promise<LoopConfig> {
  return (await readLoopConfig(repo)).config;
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

function validateStringList(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new LoopConfigError(`scout.${field} must be a list of short text lines.`);
  }
}

function validatePatch(next: LoopConfig): void {
  if (
    next.prCap !== "unlimited" &&
    (!Number.isInteger(next.prCap) || next.prCap <= 0)
  ) {
    throw new LoopConfigError('prCap must be a positive integer or "unlimited".');
  }
  if (
    next.ideaQueueCap !== "unlimited" &&
    (!Number.isInteger(next.ideaQueueCap) || next.ideaQueueCap <= 0)
  ) {
    throw new LoopConfigError('ideaQueueCap must be a positive integer or "unlimited".');
  }
  if (typeof next.autonomousBuildEnabled !== "boolean") {
    throw new LoopConfigError("autonomousBuildEnabled must be true or false.");
  }
  if (
    next.demoPort !== undefined &&
    (!Number.isInteger(next.demoPort) || next.demoPort < 1 || next.demoPort > 65535)
  ) {
    throw new LoopConfigError("demoPort must be a whole number between 1 and 65535.");
  }

  const scout = next.scout;
  if (typeof scout !== "object" || scout === null) {
    throw new LoopConfigError("scout must be an object.");
  }
  if (typeof scout.productSummary !== "string") {
    throw new LoopConfigError("scout.productSummary must be text.");
  }
  validateStringList(scout.currentGoals, "currentGoals");
  validateStringList(scout.offLimits, "offLimits");
  validateStringList(scout.lenses, "lenses");
  if (
    !Number.isInteger(scout.maxPerRun) ||
    scout.maxPerRun < 1 ||
    scout.maxPerRun > MAX_IDEAS_PER_RUN
  ) {
    throw new LoopConfigError(
      `scout.maxPerRun must be a whole number between 1 and ${MAX_IDEAS_PER_RUN}.`,
    );
  }

  const stale = scout.staleCheck;
  if (typeof stale !== "object" || stale === null) {
    throw new LoopConfigError("scout.staleCheck must be an object.");
  }
  if (typeof stale.enabled !== "boolean") {
    throw new LoopConfigError("scout.staleCheck.enabled must be true or false.");
  }
  if (
    !Number.isInteger(stale.intervalHours) ||
    stale.intervalHours < MIN_STALE_INTERVAL_HOURS ||
    stale.intervalHours > MAX_STALE_INTERVAL_HOURS
  ) {
    throw new LoopConfigError(
      `scout.staleCheck.intervalHours must be a whole number of hours between ${MIN_STALE_INTERVAL_HOURS} and ${MAX_STALE_INTERVAL_HOURS}.`,
    );
  }
}

export type LoopConfigPatch = Partial<
  Omit<LoopConfig, "scout" | "demoPort" | "models" | "extra">
> & {
  /**
   * `extra` is stripped here for the same reason it is at the top level: it is
   * a record of what was on disk, not a settable field.
   */
  scout?: Partial<Omit<ScoutConfig, "extra">>;
  /**
   * Same omitted-vs-explicit convention every other patch field already
   * relies on ("key not in the body" = leave alone), plus one more state
   * this field alone needs: an explicit `null` clears it back to unset.
   * There's no other way to represent "clear" once JSON.stringify has
   * already dropped an `undefined` value from the wire.
   */
  demoPort?: number | null;
  /**
   * Merged key by key over what is stored, so picking one agent's model never
   * touches another's. A model id sets that key; `null` clears it back to
   * "not picked". Keys left out are left alone.
   */
  models?: Record<string, string | null>;
};

/**
 * Apply a `models` patch. Only the keys being set are validated: a value the
 * owner hand-edited into another key is not this save's business, and failing
 * on it would block every unrelated save.
 */
function mergeModels(
  current: AgentModels | undefined,
  patch: unknown,
): AgentModels | undefined {
  if (patch === undefined) return current;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new LoopConfigError("models must be an object of agent -> model.");
  }
  const next: AgentModels = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (!MODEL_AGENT_IDS.includes(key)) {
      throw new LoopConfigError(
        `models.${key} isn't an agent whose model can be picked. Valid keys: ${MODEL_AGENT_IDS.join(", ")}.`,
      );
    }
    if (value === null) {
      delete next[key];
    } else if (isModelChoice(value)) {
      next[key] = value;
    } else {
      throw new LoopConfigError(
        `models.${key} must be one of: ${MODEL_CHOICES.map((c) => c.id).join(", ")}.`,
      );
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Merge `patch` over the current (or default) config, validate, and commit
 * `.github/loop-config.json` to the target repo. Returns the saved config.
 *
 * When `expectedFingerprint` is supplied and no longer matches what's stored,
 * nothing is written and a {@link LoopConfigConflictError} (409) is thrown
 * carrying the current config.
 *
 * The fingerprint check alone was not enough: `commitFile` used to look the
 * blob sha up itself, so a save that landed between the two reads was silently
 * clobbered. The sha we read here is now passed straight through to the write,
 * and GitHub rejects it if the file moved on — that rejection surfaces as the
 * same conflict error, so the UI behaves identically either way.
 */
export async function setLoopConfig(
  repo: RepoConfig,
  patch: LoopConfigPatch,
  opts: { expectedFingerprint?: string } = {},
): Promise<LoopConfig> {
  const { config: current, sha } = await readLoopConfig(repo);
  const currentFingerprint = loopConfigFingerprint(current);
  if (opts.expectedFingerprint && opts.expectedFingerprint !== currentFingerprint) {
    throw new LoopConfigConflictError(current, currentFingerprint);
  }

  // `extra` is never settable over the wire — it only ever comes from disk, so
  // strip it off the patch before anything is merged.
  const incoming = { ...(patch ?? {}) } as Record<string, unknown>;
  delete incoming.extra;
  const {
    scout: rawScoutPatch,
    demoPort: demoPortPatch,
    models: modelsPatch,
    ...rest
  } = incoming as LoopConfigPatch;
  // Same rule one level down: a caller cannot invent `scout.extra`, and a UI
  // that round-trips the whole scout block back to us must not be able to
  // overwrite what was really on disk with its own copy.
  const scoutPatch = rawScoutPatch
    ? (() => {
        const s = { ...(rawScoutPatch as Record<string, unknown>) };
        delete s.extra;
        return s as Partial<Omit<ScoutConfig, "extra">>;
      })()
    : undefined;
  const next: LoopConfig = {
    ...current,
    ...rest,
    // demoPortPatch is `undefined` only when the key was absent from the
    // patch entirely (JSON has no way to send a literal `undefined`) — that
    // means "leave it alone". An explicit `null` clears it; a number sets
    // it. Same three-state handling the API doc above describes.
    demoPort:
      demoPortPatch === undefined
        ? current.demoPort
        : demoPortPatch === null
          ? undefined
          : demoPortPatch,
    models: mergeModels(current.models, modelsPatch),
    scout: {
      ...current.scout,
      ...(scoutPatch ?? {}),
      // Merged one level deeper than everything else in this patch, so a body
      // of `{ scout: { staleCheck: { enabled: true } } }` turns the check on
      // without also resetting the interval the owner picked. Every other
      // scout field is a scalar or a whole list, where replace-wholesale is
      // exactly right; this one is the only nested object.
      staleCheck: {
        ...current.scout.staleCheck,
        ...(scoutPatch?.staleCheck ?? {}),
      },
    },
  };
  validatePatch(next);

  // Trim the free text the same way a read would, so what's stored is what a
  // reload shows (and the fingerprint we hand back stays accurate).
  // `extra` is set aside first: normalizeScout reads its input as raw file
  // JSON, so it would file the `extra` key itself as one more unknown key and
  // the save wrote `scout.extra.aiProvider` - which no workflow reads, so the
  // Scout quietly left Bedrock on the next save of any setting.
  const { extra: scoutExtra, ...scoutFields } = next.scout;
  next.scout = normalizeScout(scoutFields);
  if (scoutExtra) next.scout.extra = scoutExtra;

  try {
    await commitFile(
      LOOP_CONFIG_PATH,
      serializeLoopConfig(next),
      "dashboard: update loop config",
      { repo, expectedSha: sha },
    );
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    // 409 = the sha we passed is stale (someone saved in between). A 422 is
    // only the same story when we read the file as ABSENT and it exists now —
    // otherwise 422 is an ordinary validation failure and must not be dressed
    // up as a conflict. Either way the owner needs the config as it really
    // stands, not the one we based the merge on.
    if (status === 409 || (status === 422 && sha === null)) {
      throw await conflictFromCurrentState(repo, current, currentFingerprint);
    }
    throw err;
  }
  return next;
}

/**
 * Build the 409 for a write GitHub refused, carrying whatever is really stored
 * now. Falls back to what we read at the start of the save if that re-read
 * fails — a slightly stale conflict is far better than a 502 that hides the
 * fact the save didn't happen.
 */
async function conflictFromCurrentState(
  repo: RepoConfig,
  fallbackConfig: LoopConfig,
  fallbackFingerprint: string,
): Promise<LoopConfigConflictError> {
  try {
    const latest = await getLoopConfig(repo);
    return new LoopConfigConflictError(latest, loopConfigFingerprint(latest));
  } catch {
    return new LoopConfigConflictError(fallbackConfig, fallbackFingerprint);
  }
}
