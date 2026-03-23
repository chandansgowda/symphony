/**
 * Pastel color palette for workflow card colors.
 * Each entry has a hex value and a display label.
 */

export interface PastelColor {
  value: string;
  label: string;
}

export const PASTEL_COLORS: PastelColor[] = [
  { value: '#f9a8d4', label: 'Pink' },
  { value: '#fca5a5', label: 'Red' },
  { value: '#fdba74', label: 'Orange' },
  { value: '#fde047', label: 'Yellow' },
  { value: '#86efac', label: 'Green' },
  { value: '#6ee7b7', label: 'Emerald' },
  { value: '#67e8f9', label: 'Cyan' },
  { value: '#93c5fd', label: 'Blue' },
  { value: '#a5b4fc', label: 'Indigo' },
  { value: '#c4b5fd', label: 'Violet' },
  { value: '#f0abfc', label: 'Fuchsia' },
  { value: '#d9f99d', label: 'Lime' },
];

/**
 * Pick a color automatically based on an index (e.g., number of existing workflows).
 * Cycles through the pastel palette.
 */
export function pickAutoColor(index: number): string {
  return PASTEL_COLORS[index % PASTEL_COLORS.length].value;
}

/**
 * Simple hash function for strings.
 * Returns a positive integer hash value.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Get a stable color for a workflow based on its ID.
 * Uses the pastel palette for consistent, visually pleasing results.
 *
 * @param workflowId - The workflow ID (or name as fallback)
 * @returns A hex color string
 */
export function getWorkflowColor(workflowId: string | undefined | null): string {
  if (!workflowId) {
    return '#9ca3af'; // Gray for no workflow
  }

  const hash = hashString(workflowId);
  const colorIndex = hash % PASTEL_COLORS.length;
  return PASTEL_COLORS[colorIndex].value;
}

/**
 * Get a lighter version of the workflow color for backgrounds.
 *
 * @param workflowId - The workflow ID (or name as fallback)
 * @returns A hex color string with reduced opacity (as rgba)
 */
export function getWorkflowColorLight(workflowId: string | undefined | null): string {
  const color = getWorkflowColor(workflowId);
  // Convert hex to rgba with low opacity
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.15)`;
}
