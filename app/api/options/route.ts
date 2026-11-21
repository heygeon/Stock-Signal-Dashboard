import { OPTIONS_UNAVAILABLE } from "@/lib/options";
import { getOptionsChain } from "@/lib/yahoo-options";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  try {
    const { httpStatus, body } = await getOptionsChain(symbol);
    return Response.json(body, { status: httpStatus });
  } catch (error) {
    console.error(error);
    return Response.json(
      { status: "unavailable", symbol, reason: OPTIONS_UNAVAILABLE },
      { status: 500 },
    );
  }
}
