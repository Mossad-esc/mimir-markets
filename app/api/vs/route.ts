import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { CATEGORIES } from "@/lib/constants";
import { getVsFeedSnapshot, type VsFeedOptions, type VsSort } from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";

export const dynamic = "force-dynamic";

const VALID_STATES = ["open", "active", "resolved", "cancelled"] as const;
type VsState = (typeof VALID_STATES)[number];
const VALID_CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

interface ParsedVsParams extends VsFeedOptions {
  forceRefresh: boolean;
}

export function parseVsListParams(searchParams: URLSearchParams): 
  | { kind: "ok"; params: ParsedVsParams }
  | { kind: "error"; status: number; body: unknown; headers: Record<string, string> } {
  const refreshValue = searchParams.get("refresh");
  if (refreshValue && refreshValue !== "1") {
    return { kind: "error", ...apiError("invalid_request", "refresh must be 1 when provided", { field: "refresh" }) };
  }
  const forceRefresh = refreshValue === "1";

  const cursorValue = searchParams.get("cursor");
  const limitValue = searchParams.get("limit");
  const cursor = cursorValue ? Number(cursorValue) : undefined;
  const limit = limitValue ? Number(limitValue) : undefined;
  if (cursor !== undefined && (isNaN(cursor) || cursor <= 0)) {
    return { kind: "error", ...apiError("invalid_request", "cursor must be a positive integer", { field: "cursor" }) };
  }
  if (limit !== undefined && (isNaN(limit) || limit <= 0 || limit > 100)) {
    return { kind: "error", ...apiError("invalid_request", "limit must be between 1 and 100", { field: "limit" }) };
  }

  const categoryRaw = searchParams.get("category");
  const category = categoryRaw ? categoryRaw.trim() : undefined;
  if (category !== undefined && !VALID_CATEGORY_IDS.has(category)) {
    return { kind: "error", ...apiError("invalid_request", "invalid category", { field: "category" }) };
  }

  const stateValues = searchParams.getAll("state");
  const states = stateValues.length > 0 ? stateValues : undefined;
  if (states !== undefined && states.some((s) => !VALID_STATES.includes(s as VsState))) {
    return { kind: "error", ...apiError("invalid_request", "invalid state", { field: "state" }) };
  }

  const creatorRaw = searchParams.get("creator");
  const creator = creatorRaw === null ? undefined : creatorRaw.trim();
  if (creator !== undefined && creator.length === 0) {
    return { kind: "error", ...apiError("invalid_request", "creator must be a non-empty address", { field: "creator" }) };
  }

  const providedSort = searchParams.get("sort");
  const sortRaw = (providedSort ?? "newest").toLowerCase();
  let sort: VsSort;
  if (!["newest", "expiring", "updated"].includes(sortRaw)) {
    if (providedSort !== null && providedSort !== "") {
      return { kind: "error", ...apiError("invalid_request", "invalid sort", { field: "sort" }) };
    }
    sort = "newest";
  } else {
    sort = sortRaw as VsSort;
  }

  return { kind: "ok", params: { forceRefresh, cursor, limit, category, states, creator, sort } };
}

export async function GET(request: Request) {
  try {
    const { authorizeRequest } = await import("@/lib/api/policy");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const gate = authorizeRequest("public_read", { route: "/api/vs", ip });
    if (!gate.allowed && gate.error) {
      return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
    }
    const { searchParams } = new URL(request.url);
    const parsed = parseVsListParams(searchParams);
    if (parsed.kind === "error") {
      return NextResponse.json(parsed.body, { status: parsed.status, headers: parsed.headers });
    }
    const { forceRefresh, cursor, limit, category, states, creator, sort } = parsed.params;
    const { items, cache, nextCursor } = await getVsFeedSnapshot({
      forceRefresh,
      cursor,
      limit,
      category,
      states,
      creator,
      sort,
    });
    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
        nextCursor,
      },
      {
        headers: VS_CACHE_HEADERS,
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load VS feed");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
