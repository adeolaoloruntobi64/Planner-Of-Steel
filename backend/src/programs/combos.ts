export type ProgramType = 'specialist' | 'major' | 'minor';

export function classifyProgramType(name: string): ProgramType | null {
  const upper = name.toUpperCase();
  if (upper.includes('SPECIALIST')) return 'specialist';
  if (upper.includes('MAJOR')) return 'major';
  if (upper.includes('MINOR')) return 'minor';
  return null;
}

/** UofT's actual POSt-combination rules — only these shapes make up a complete degree. */
export function isValidCombo(types: (ProgramType | null)[]): boolean {
  if (types.some((t) => t === null)) return false;
  const spec = types.filter((t) => t === 'specialist').length;
  const major = types.filter((t) => t === 'major').length;
  const minor = types.filter((t) => t === 'minor').length;
  if (spec === 1 && major === 0 && minor === 0) return true; // 1 Specialist
  if (spec === 2 && major === 0 && minor === 0) return true; // 2 Specialists (double degree)
  if (spec === 1 && major === 1 && minor === 0) return true; // Specialist + Major
  if (spec === 1 && major === 0 && minor === 1) return true; // Specialist + Minor
  if (spec === 0 && major === 2 && minor === 0) return true; // 2 Majors
  if (spec === 0 && major === 1 && minor === 2) return true; // Major + 2 Minors
  return false;
}
