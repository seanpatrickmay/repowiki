import type { APIRoute, GetStaticPaths } from "astro";
import { previewData } from "../../../preview.ts";
import { getSite } from "../../../site.ts";

export const getStaticPaths: GetStaticPaths = () => {
  const site = getSite();
  return [...site.features.keys()]
    .filter((id) => previewData(site, id) !== null)
    .map((slug) => ({ params: { slug } }));
};

export const GET: APIRoute = ({ params }) =>
  new Response(JSON.stringify(previewData(getSite(), params.slug ?? "")), {
    headers: { "content-type": "application/json" },
  });
