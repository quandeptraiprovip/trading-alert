import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { loadPlaybookDocument, savePlaybookDocument } from "../../../playbook-store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await loadPlaybookDocument(request.nextUrl.searchParams.get("symbol")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    return NextResponse.json(await savePlaybookDocument(await request.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
