export type ProgramType = 'specialist' | 'major' | 'minor';

export function classifyProgramType(name: string): ProgramType | null {
  const upper = name.toUpperCase();
  if (upper.includes('SPECIALIST')) return 'specialist';
  if (upper.includes('MAJOR')) return 'major';
  if (upper.includes('MINOR')) return 'minor';
  return null;
}

const TYPE_LABEL: Record<ProgramType, string> = {
  specialist: 'Specialist',
  major: 'Major',
  minor: 'Minor',
};

export function typeLabel(type: ProgramType | null): string {
  return type ? TYPE_LABEL[type] : 'Unknown';
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

/** A short, human message describing what to add (or that the combo is already complete). */
export function comboGuidance(types: (ProgramType | null)[]): string {
  if (types.length === 0) {
    return 'Add a Specialist, or a Major, to get started.';
  }
  if (isValidCombo(types)) {
    return 'This is a complete, valid combination.';
  }
  const spec = types.filter((t) => t === 'specialist').length;
  const major = types.filter((t) => t === 'major').length;
  const minor = types.filter((t) => t === 'minor').length;

  if (spec >= 1 && (major > 1 || minor > 1 || (major >= 1 && minor >= 1)) ) {
    return 'This combination isn’t supported alongside a Specialist. A Specialist can only be paired with one Major, one Minor, or one other Specialist.';
  }
  if (major === 1 && minor === 0 && spec === 0) return 'Add one more Major, or two Minors, to complete this combination.';
  if (major === 1 && minor === 1 && spec === 0) return 'Add one more Minor to complete Major + 2 Minors.';
  if (major === 0 && minor >= 1 && spec === 0) return 'A Minor alone isn’t a complete combination — pair it with a Major (plus one more Minor) or a Specialist.';
  if (spec > 2) return 'At most 2 Specialists (a double degree) are supported.';
  if (major > 2) return 'At most 2 Majors are supported.';
  if (minor > 2) return 'At most 2 Minors are supported (paired with 1 Major).';
  return 'Supported combinations: 1 Specialist, 2 Specialists, Specialist + Major, Specialist + Minor, 2 Majors, or 1 Major + 2 Minors.';
}
