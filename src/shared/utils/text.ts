// src/shared/utils/text.ts
export function sanitizeForJson(text: string): string {
  // Rimuove caratteri di controllo non ammessi nelle stringhe JSON.
  // Manteniamo \t \n \r, togliamo il resto U+0000..U+001F.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}
