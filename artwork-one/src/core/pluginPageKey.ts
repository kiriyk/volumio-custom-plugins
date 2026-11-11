/** Normalize the category separator once; plugin names may themselves contain dashes. */
export function pageKey(page: string): string {
  const value = String(page || '');
  return value.includes('/') ? value : value.replace('-', '/');
}
