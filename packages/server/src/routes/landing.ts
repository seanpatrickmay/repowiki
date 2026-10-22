import type { Deps } from "../app.ts";
import type { Route } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import { currentSession } from "../http/session.ts";

/** `GET /` on the app host: the dashboard when signed in, else the public home page (ADR-0016). */
export function landingRoutes(deps: Deps): Route[] {
  return [
    {
      method: "GET",
      pattern: "/",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        // Signed out, the front door is the public site's home page (ADR-0016).
        if (session === null) return redirect(`${deps.config.publicOrigin}/`, 302);
        return redirect("/dashboard", 302);
      },
    },
  ];
}
