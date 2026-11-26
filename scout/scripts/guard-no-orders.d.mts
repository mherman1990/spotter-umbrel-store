export const FORBIDDEN: string[];
export function findViolations(root: string): { file: string; line: number; pattern: string }[];
export function isSkippedPath(rel: string): boolean;
