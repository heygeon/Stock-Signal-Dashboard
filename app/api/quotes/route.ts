import { QuoteError, getQuote } from "@/lib/quotes";

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  try {
    const quote = await getQuote(symbol);
    return Response.json(quote);
  } catch (error) {
    if (error instanceof QuoteError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return Response.json({ error: "Quote request failed." }, { status: 500 });
  }
}
