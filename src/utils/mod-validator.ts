/**
 * Supported mods in Lanify:
 * EZ, NF, HT, DT, NC, SD, HD, NM
 * (HR, FI, FL, MR, RN, CN are unsupported and should be rejected)
 */
const SUPPORTED_MODS = new Set(['NM', 'EZ', 'NF', 'HT', 'DT', 'NC', 'SD', 'HD']);

export function validateMods(modsString: string): { valid: boolean; error?: string } {
  if (!modsString || modsString === '[]' || modsString === '["NM"]') return { valid: true };

  let mods: string[];
  try {
    mods = JSON.parse(modsString);
    if (!Array.isArray(mods)) throw new Error('Not an array');
  } catch {
    return { valid: false, error: 'Mods must be a JSON array of strings' };
  }

  if (mods.length === 0) return { valid: true };

  // 1. Reject unsupported mods
  for (const mod of mods) {
    if (!SUPPORTED_MODS.has(mod)) {
      return { valid: false, error: `Unsupported mod: ${mod}` };
    }
  }

  const modSet = new Set(mods);

  // 2. Mutual exclusion groups

  // Speed group: NM / HT / DT / NC
  let speedCount = 0;
  if (modSet.has('HT')) speedCount++;
  if (modSet.has('DT')) speedCount++;
  if (modSet.has('NC')) speedCount++;
  
  if (speedCount > 1) {
    return { valid: false, error: 'HT, DT, and NC are mutually exclusive' };
  }
  
  if (modSet.has('NM')) {
    if (speedCount > 0) {
      return { valid: false, error: 'NM is mutually exclusive with speed-adjusting mods' };
    }
    if (modSet.has('NF') || modSet.has('SD')) {
      return { valid: false, error: 'NM is mutually exclusive with fail-condition mods' };
    }
  }

  // Fail group: NM / NF / SD
  let failCount = 0;
  if (modSet.has('NF')) failCount++;
  if (modSet.has('SD')) failCount++;
  
  if (failCount > 1) {
    return { valid: false, error: 'NF and SD are mutually exclusive' };
  }

  return { valid: true };
}
