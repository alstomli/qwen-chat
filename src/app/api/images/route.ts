import { imageProxy } from "@/lib/image-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => imageProxy(request);
export const POST = (request: Request) => imageProxy(request);
