import { imageJson, imageRouteError, inspectImageJob } from "@/lib/image-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  try { return imageJson(await inspectImageJob(request, jobId)); }
  catch (error) { return imageRouteError(error); }
}
