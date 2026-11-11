import { imageProxy } from "@/lib/image-server";
export const maxDuration = 60;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) { return imageProxy(request, (await context.params).jobId, true); }
