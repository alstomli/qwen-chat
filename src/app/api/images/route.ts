import { sameOrigin } from "@/lib/auth";
import { createImageJob, imageAvailability, imageJson, imageRouteError } from "@/lib/image-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try { return imageJson(imageAvailability(request)); }
  catch (error) { return imageRouteError(error); }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return imageJson({ error: "This request isn't allowed." }, 403);
  try { return imageJson(await createImageJob(request), 202); }
  catch (error) { return imageRouteError(error); }
}
