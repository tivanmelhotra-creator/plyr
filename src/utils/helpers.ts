import path from 'path';

/**
 * Parse number from string or number input
 * Handles: 5, "5", "5.5" → 5
 */
export const parseNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return isNaN(value) ? undefined : value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

/**
 * Parse integer from string or number input
 */
export const parseInteger = (value: unknown): number | undefined => {
  const num = parseNumber(value);
  return num !== undefined ? Math.floor(num) : undefined;
};

/**
 * Parse boolean from various inputs
 * Handles: true, false, "true", "false", 1, 0, "1", "0"
 */
export const parseBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (['true', '1', 'yes'].includes(lower)) return true;
    if (['false', '0', 'no'].includes(lower)) return false;
  }
  return undefined;
};

/**
 * Prevent path traversal attacks
 */
export const securePath = (base: string, ...parts: string[]): string => {
  const resolved = path.resolve(base, ...parts);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error('Path Traversal Detected');
  }
  return resolved;
};

/**
 * Check if user is VIP based on priority
 */
export const isVipUser = (priority: number, threshold: number): boolean => {
  return priority < threshold;
};