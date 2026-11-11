import { imageProxy } from "@/lib/image-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, context: Context) { return imageProxy(request, (await context.params).jobId); }
export async function DELETE(request: Request, context: Context) { return imageProxy(request, (await context.params).jobId); }
