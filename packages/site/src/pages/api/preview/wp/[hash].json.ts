import type { APIRoute, GetStaticPaths } from "astro";
import { wikipediaPreviews } from "../../../../preview.ts";
import { getSite } from "../../../../site.ts";

export const getStaticPaths: GetStaticPaths = () =>
  [...wikipediaPreviews(getSite()).keys()].map((hash) => ({ params: { hash } }));

export const GET: APIRoute = ({ params }) =>
  new Response(JSON.stringify(wikipediaPreviews(getSite()).get(params.hash ?? "") ?? null), {
    headers: { "content-type": "application/json" },
  });
