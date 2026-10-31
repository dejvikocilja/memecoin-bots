import { readFile, stat } from 'node:fs/promises';

import { createAppContext } from '@memebots/config';
import { isProfileObject } from '@memebots/core';

import { createPool } from './pool.js';
import {
  getRiskProfile,
  listRiskProfiles,
  RiskProfileConflictError,
  updateRiskProfile,
} from './risk-profiles.js';

const [command = 'list', id, file, ...extra] = process.argv.slice(2);
const context = createAppContext(process.env, (line) => process.stderr.write(`${line}\n`));
if (!context) {
  process.exitCode = 1;
} else {
  const pool = createPool(context.config.databaseUrl.reveal(), { max: 1 });
  try {
    let result: unknown;
    if (command === 'list' && id === undefined) {
      result = await listRiskProfiles(pool);
    } else if (command === 'get' && id !== undefined && file === undefined) {
      result = await getRiskProfile(pool, id);
      if (!result) throw new Error('Risk profile not found');
    } else if (
      command === 'update' &&
      id !== undefined &&
      file !== undefined &&
      extra.length === 0
    ) {
      if ((await stat(file)).size > 32768) throw new Error('Profile edit file is too large');
      const input: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (
        !isProfileObject(input) ||
        Object.keys(input).length !== 2 ||
        typeof input.expectedRevision !== 'string' ||
        !Object.hasOwn(input, 'changes')
      ) {
        throw new Error('Edit file requires exactly expectedRevision and changes');
      }
      result = await updateRiskProfile(pool, id, input.changes, {
        expectedRevision: input.expectedRevision,
        actor: 'owner:profile-cli',
      });
    } else {
      throw new Error('Usage: profiles list | get <id> | update <id> <json-file>');
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    // JSON/SQL errors can contain arbitrary local input. Keep failures bounded and fixed.
    if (err instanceof RiskProfileConflictError) {
      context.logger.error('risk_profile_conflict', {
        message: 'Profile changed; reload its current revision before editing',
      });
    } else {
      context.logger.error('risk_profile_command_failed', {
        message: 'Profile command failed; check policy, file and current revision',
      });
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
