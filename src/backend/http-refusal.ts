/**
 * backend/http-refusal — turning a status code into a sentence a person can act
 * on, for the two doors that speak to an OpenAI-compatible server.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Both doors used to refuse the same way: the status, the status text, and the
 * first few hundred characters of whatever the server said. That is honest and
 * it is nearly useless, because the four things most likely to be wrong all
 * arrive looking identical — a bare 4xx and a blob of JSON:
 *
 *   - the server wants headers this run did not send, or sent wrong
 *   - the server speaks a protocol version this run did not name
 *   - the server is up but is not holding the model that was asked for
 *   - the server is a different server than the one somebody meant
 *
 * A person reading "answered 400" learns nothing about which. A person reading
 * "the server is up but is not holding a model" goes and loads one. So the
 * status is read where reading it says something specific, and everything else
 * falls through to the old sentence unchanged.
 *
 * ── The rule this file follows ──────────────────────────────────────────────
 *
 * STRICT ABOUT WHAT IT CLAIMS TO UNDERSTAND, SILENT ABOUT THE REST. A status
 * this file recognises gets a sentence asserting what it means. Anything else
 * gets the server's own words and no interpretation, because a confident
 * explanation of a status nobody has seen would send the reader somewhere the
 * bug is not.
 *
 * IT NAMES NO PRODUCT. `426` means a version header is missing whoever is
 * serving; `model_not_resident` is a string some servers use and others do not.
 * The sentences describe the CONDITION, never the vendor — this program must
 * not be able to tell one OpenAI-compatible server from another.
 */

/** How much of a server's own answer is worth quoting back. */
const BODY_EXCERPT = 400;

/**
 * The sentence for a refusal, without the caller's own context.
 *
 * `body` is the server's answer as text; it is quoted back in every branch,
 * because the branch that guessed wrong is exactly the one where the raw words
 * matter. What changes between branches is the sentence IN FRONT of it.
 */
export function explainHttpRefusal(status: number, statusText: string, body: string): string {
  const said = body.trim().slice(0, BODY_EXCERPT);
  const tail = said.length > 0 ? ` It said: ${said}` : '';
  const answered = `answered ${status}${statusText.length > 0 ? ` ${statusText}` : ''}.`;

  if (status === 426) {
    return `${answered} That status means the server requires a protocol version this request `
      + 'did not name — a server behind a private router usually wants an API-version header '
      + `alongside its credential. Both are set through $FOUNDRY_ENDPOINT_HEADERS.${tail}`;
  }
  if (status === 401 || status === 403) {
    return `${answered} The server refused this request's credentials: either none were sent, or `
      + 'the ones sent are not the ones it minted. Headers come from '
      + `$FOUNDRY_ENDPOINT_HEADERS, or from "backend.endpointHeaders" in settings.json.${tail}`;
  }
  if (/model_not_resident/i.test(said)) {
    return `${answered} The server is running but is NOT holding the model this run asked for, and `
      + 'it will not load one to answer a request — a model has to be made resident on that '
      + `machine first. Nothing here can do it from this side.${tail}`;
  }
  if (status === 404) {
    return `${answered} Either the model named is not one this server serves, or the URL is not `
      + `the server's OpenAI-compatible mount (it should end in /v1).${tail}`;
  }
  return `${answered}${tail}`;
}
