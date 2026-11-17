import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { OperatorSite } from "../operator-site.js";

/**
 * `GET /api/instance` — what this instance tells whoever is signed in about
 * itself: for now, the links its dashboard shows — the operator's docs, terms
 * and privacy policy. Configuration the instance already shows on its pages,
 * nothing about the caller: any credential reads it (a session, an API key of
 * any reach, the dev token), and a request with none gets the 401 of every
 * authenticated route.
 *
 * The values are the ones the start validated, in the form the pages serve
 * them; they change only when the server restarts, so the dashboard reads them
 * once per session. The `links` envelope leaves room for more of the
 * instance's own settings without changing the shape.
 *
 * Nothing here is under `GET /api/me`, which stays as it is.
 */

/** The route's body. */
export interface InstanceResponse {
  links: {
    /** Where the docs are: the operator's address, or this server's API reference (`/docs`). */
    docs: string;
    /** The operator's terms; `null` when none is set. */
    terms: string | null;
    /** The operator's privacy policy; `null` when none is set. */
    privacy: string | null;
  };
}

export function createInstanceRoutes(authMiddleware: MiddlewareHandler, site: OperatorSite): Hono {
  const router = new Hono();

  // Built once, from the settings read at start: every request serves the same body.
  const body: InstanceResponse = {
    links: {
      docs: site.links.docs,
      terms: site.links.terms ?? null,
      privacy: site.links.privacy ?? null,
    },
  };

  router.get("/instance", authMiddleware, (c) => c.json(body));

  return router;
}
