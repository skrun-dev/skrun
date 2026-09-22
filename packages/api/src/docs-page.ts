/**
 * Interactive API docs page (`GET /docs`).
 *
 * The page is ours; the renderer is Scalar's browser bundle, fetched from jsdelivr
 * at an exact version AND an integrity hash. The browser refuses the script when a
 * single byte differs from the hash recorded here, so neither a new npm publish of
 * `@scalar/api-reference` nor a tampered CDN response can run on this origin — where
 * it would run with the signed-in user's session cookie attached to every request.
 *
 * The page carries no inline script: Scalar reads its configuration from the
 * `#api-reference[data-configuration]` element, so the CSP on `/docs` can name
 * exactly one script source (see `index.ts`).
 *
 * Scalar's defaults route every "Try it" request through `proxy.scalar.com` and load
 * fonts from `fonts.scalar.com`. Both are switched off: nothing typed into the
 * console (an API key, a request body) leaves this origin, and the CSP's
 * `connect-src 'self'` makes that a hard rule rather than a setting.
 *
 * To bump the bundle: change SCALAR_VERSION, then recompute the hash from the file
 * the browser will actually fetch —
 *   curl -s "https://cdn.jsdelivr.net/npm/@scalar/api-reference@<version>/dist/browser/standalone.js" \
 *     | openssl dgst -sha384 -binary | openssl base64 -A
 * — and paste it into SCALAR_BUNDLE_SRI. A mismatch blanks the page, visibly.
 */

export const SCALAR_VERSION = "1.68.0";

export const SCALAR_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`;

export const SCALAR_BUNDLE_SRI =
  "sha384-PhSzhE9ihf7z/cKeRSKAeP+oJMMzotyFv0EjvNYgL798a2ODBQVuJLTP4Klle6IB";

export interface DocsPageOptions {
  /** Same-origin URL of the OpenAPI document. */
  specUrl: string;
  pageTitle: string;
}

/** Scalar configuration the page declares. Exported so tests can pin its values. */
export function docsPageConfiguration(specUrl: string): Record<string, unknown> {
  return {
    url: specUrl,
    // "" disables the request proxy: "Try it" calls go straight to this origin.
    proxyUrl: "",
    // No fonts.scalar.com — system fonts only.
    withDefaultFonts: false,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderDocsPage({ specUrl, pageTitle }: DocsPageOptions): string {
  const configuration = escapeHtml(JSON.stringify(docsPageConfiguration(specUrl)));
  return `<!doctype html>
<html>
  <head>
    <title>${escapeHtml(pageTitle)}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-configuration="${configuration}"></script>
    <script src="${SCALAR_BUNDLE_URL}" integrity="${SCALAR_BUNDLE_SRI}" crossorigin="anonymous"></script>
  </body>
</html>`;
}
