// SPDX-License-Identifier: MIT-0
/**
 * Loads and validates the arms file.
 *
 * Resolution order: an explicit path (context `armsFile`), then `arms.json` at
 * the repository root — the same file the runtime reads (v2/src/arms.ts), and
 * the single source of truth; arms.schema.json documents the shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArmDescriptor, assertArmKey, assertPrefix } from './names';

export interface ArmsFile {
  /** Deployment prefix; the `prefix` context value overrides it. */
  prefix?: string;
  arms: ArmDescriptor[];
}

export const ROOT_ARMS_FILE = path.resolve(__dirname, '..', '..', 'arms.json');

const KINDS = new Set(['agent', 'pipeline']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function resolveArmsFile(explicit?: string): string {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) throw new Error(`armsFile "${explicit}" does not exist (resolved to ${p})`);
    return p;
  }
  if (!fs.existsSync(ROOT_ARMS_FILE)) {
    throw new Error(`arms.json not found at ${ROOT_ARMS_FILE}; pass -c armsFile=<path> or restore the repository's arms.json (the runtime reads the same file)`);
  }
  return ROOT_ARMS_FILE;
}

export function loadArmsFile(file: string): ArmsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`arms file ${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`arms file ${file} must be an object { prefix?, arms[] }`);
  }
  const obj = parsed as Record<string, unknown>;
  const prefix = obj.prefix === undefined ? undefined : assertPrefix(String(obj.prefix));
  return { prefix, arms: validateArms(obj.arms, file) };
}

/** Structural validation with a path in every message; the runtime's zod schema is the richer twin. */
export function validateArms(input: unknown, source = 'arms'): ArmDescriptor[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error(`${source}: "arms" must be a non-empty array`);
  }
  const keys = new Set<string>();
  let pipelines = 0;
  return input.map((raw, i) => {
    const at = `${source}: arms[${i}]`;
    if (typeof raw !== 'object' || raw === null) throw new Error(`${at} must be an object`);
    const a = raw as Record<string, unknown>;

    const str = (field: string): string => {
      if (typeof a[field] !== 'string' || (a[field] as string).length === 0) {
        throw new Error(`${at}.${field} must be a non-empty string`);
      }
      return a[field] as string;
    };
    const num = (field: string, integer = false): number => {
      const v = a[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
        throw new Error(`${at}.${field} must be a non-negative ${integer ? 'integer' : 'number'}`);
      }
      return v;
    };

    const key = assertArmKey(str('key'));
    if (keys.has(key)) throw new Error(`${at}.key "${key}" is duplicated`);
    keys.add(key);

    const kind = str('kind');
    if (!KINDS.has(kind)) throw new Error(`${at}.kind must be "agent" or "pipeline"`);
    if (kind === 'pipeline' && ++pipelines > 1) {
      throw new Error(`${at}: only one arm may be of kind "pipeline" (it owns the core table)`);
    }

    // Optional / nullable fields follow arms.schema.json: null means "not set".
    if (a.effort !== undefined && a.effort !== null && !EFFORTS.has(String(a.effort))) {
      throw new Error(`${at}.effort must be one of low|medium|high|xhigh|max (or null)`);
    }
    if (a.worldModel !== undefined && typeof a.worldModel !== 'boolean') {
      throw new Error(`${at}.worldModel must be a boolean when present`);
    }
    const budget = a.dailyBudgetUsd === undefined || a.dailyBudgetUsd === null ? null : num('dailyBudgetUsd');
    const cap = a.maxInvestigationsPerDay === undefined || a.maxInvestigationsPerDay === null ? undefined : num('maxInvestigationsPerDay', true);

    return {
      key,
      kind: kind as ArmDescriptor['kind'],
      label: str('label'),
      model: str('model'),
      effort: (a.effort ?? undefined) as ArmDescriptor['effort'],
      worldModel: a.worldModel === true,
      dailyBudgetUsd: budget,
      maxInvestigationsPerDay: cap,
    };
  });
}
