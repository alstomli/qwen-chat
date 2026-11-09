import { registrationAvailable } from "@/lib/registration";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json({ available: await registrationAvailable() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
