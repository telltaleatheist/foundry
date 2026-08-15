/**
 * bom — the three bytes at the front of somebody else's file.
 *
 * `JSON.parse` throws on a leading U+FEFF. The specification says so: a JSON
 * text is a value, a BOM is not whitespace, and every parser that follows the
 * grammar refuses one. That would be a curiosity except that WINDOWS WRITES
 * THEM BY DEFAULT — PowerShell's `Out-File`, `>` and `Set-Content -Encoding
 * utf8` all emit a UTF-8 BOM, and so do several editors — so the same file that
 * reads perfectly when the app wrote it fails to parse when a person or a setup
 * script touched it with the one shell that ships on the platform.
 *
 * MEASURED, NOT ANTICIPATED: it landed live, on a project file the app writes
 * and PowerShell had rewritten. The engine reads files of exactly the same
 * shape — an overlay somebody hand-edited, a settings file an installer wrote,
 * a bank a script copied — and every one of them would have failed with "is not
 * JSON", which is a true sentence pointing at an invisible cause.
 *
 * So the mark comes off at every door where JSON arrives from outside this
 * program, and NOWHERE ELSE. It is not stripped from prose, from a model's
 * answer or from the middle of a file: U+FEFF inside a document is a zero-width
 * no-break space, which is content, and a program that quietly deleted it from
 * a book would be editing somebody's text. Only the first character, only on
 * the way in.
 */

/** The byte order mark, gone — and only when it is the very first character. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
