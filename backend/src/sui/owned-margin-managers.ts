/**
 * Fetch margin managers owned by an address from chain (Option 1: no DB).
 * Uses getOwnedObjects with MoveModule filter, then getObject to read deepbook_pool_id.
 */

import { mainnetPackageIds, testnetPackageIds } from "@mysten/deepbook-v3";
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

export type OwnedMarginManagersParams = {
  owner: string;
  network?: "mainnet" | "testnet";
};

export type OwnedMarginManagerEntry = {
  margin_manager_id: string;
  deepbook_pool_id: string;
};

export type OwnedMarginManagersResult = {
  managers: OwnedMarginManagerEntry[];
};

const MARGIN_MANAGER_MODULE = "margin_manager";

/** Extract pool ID string from RPC field (string or { value/id: string }). */
function normalizePoolId(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.startsWith("0x")) return raw;
  if (raw && typeof raw === "object") {
    const v =
      (raw as Record<string, unknown>).value ??
      (raw as Record<string, unknown>).id;
    if (typeof v === "string" && v.startsWith("0x")) return v;
  }
  return undefined;
}

function getMarginPackageId(network: "mainnet" | "testnet"): string {
  return network === "mainnet"
    ? mainnetPackageIds.MARGIN_PACKAGE_ID
    : testnetPackageIds.MARGIN_PACKAGE_ID;
}

/** Fallback when getOwnedObjects returns 0 (e.g. MarginManager is shared): query creation events by sender. */
async function getManagersFromCreationEvents(
  client: SuiJsonRpcClient,
  packageId: string,
  owner: string
): Promise<OwnedMarginManagerEntry[]> {
  const managers: OwnedMarginManagerEntry[] = [];
  const seen = new Set<string>();

  // Paginate queryEvents (RPC page limit is 50) so we can scan more than the
  // most recent 50 events. Stop after a reasonable cap to avoid unbounded work.
  type QueryEventsData = Awaited<
    ReturnType<SuiJsonRpcClient["queryEvents"]>
  >["data"];
  type QueryEventsCursor = Awaited<
    ReturnType<SuiJsonRpcClient["queryEvents"]>
  >["nextCursor"];

  const queryEventsPaginated = async (
    query: Parameters<SuiJsonRpcClient["queryEvents"]>[0]["query"],
    maxEvents = 500
  ): Promise<QueryEventsData> => {
    const all: QueryEventsData = [];
    let cursor: QueryEventsCursor = null;
    const pageLimit = 50;
    let pages = 0;
    const maxPages = 20;
    do {
      const { data, nextCursor, hasNextPage } = await client.queryEvents({
        query,
        limit: pageLimit,
        cursor: cursor ?? undefined,
      });
      if (data && data.length) {
        all.push(...data);
      }
      cursor = hasNextPage ? nextCursor : null;
      pages += 1;
    } while (cursor && all.length < maxEvents && pages < maxPages);
    return all;
  };

  let events: QueryEventsData = [];
  try {
    events = await queryEventsPaginated({ Sender: owner });
  } catch (err) {
    console.log(
      "[owned-margin-managers] fallback queryEvents(Sender) error:",
      err
    );
  }
  if (events.length === 0) {
    try {
      events = await queryEventsPaginated({
        MoveEventModule: { package: packageId, module: MARGIN_MANAGER_MODULE },
      });
    } catch (err) {
      console.log(
        "[owned-margin-managers] fallback queryEvents(MoveEventModule) error:",
        err
      );
    }
  }

  console.log(
    "[owned-margin-managers] fallback: queryEvents returned",
    events.length,
    "events"
  );

  for (const e of events) {
    const ev = e as { parsedJson?: Record<string, unknown>; type?: string };
    const p = ev.parsedJson;
    if (!p) continue;
    const eventOwner = (p.owner ?? p.sender) as string | undefined;
    if (eventOwner?.toLowerCase() !== owner.toLowerCase()) continue;
    const marginManagerId = (p.margin_manager_id ?? p.marginManagerId) as
      | string
      | undefined;
    const deepbookPoolId = (p.deepbook_pool_id ??
      p.deepbookPoolId ??
      p.pool_id) as string | undefined;
    if (
      marginManagerId &&
      typeof marginManagerId === "string" &&
      marginManagerId.startsWith("0x") &&
      !seen.has(marginManagerId)
    ) {
      seen.add(marginManagerId);
      const poolId =
        typeof deepbookPoolId === "string" && deepbookPoolId.startsWith("0x")
          ? deepbookPoolId
          : "";
      managers.push({
        margin_manager_id: marginManagerId,
        deepbook_pool_id: poolId,
      });
    }
  }

  if (events.length > 0 && managers.length === 0) {
    const first = events[0] as {
      parsedJson?: Record<string, unknown>;
      type?: string;
    };
    console.log(
      "[owned-margin-managers] fallback: first event type:",
      first.type,
      "parsedJson keys:",
      first.parsedJson ? Object.keys(first.parsedJson) : []
    );
  }

  return managers;
}

export async function getOwnedMarginManagers(
  params: OwnedMarginManagersParams
): Promise<OwnedMarginManagersResult> {
  const { owner, network = "mainnet" } = params;
  const packageId = getMarginPackageId(network);
  const url = getJsonRpcFullnodeUrl(network);
  const client = new SuiJsonRpcClient({ url, network });

  // Helper: paginate getOwnedObjects up to a reasonable cap so wallets with many
  // margin managers are fully captured.
  async function getOwnedObjectsPaginated(
    filter:
      | { MoveModule: { package: string; module: string } }
      | { Package: string }
  ) {
    const all: Awaited<ReturnType<typeof client.getOwnedObjects>>["data"] = [];
    let cursor: string | null | undefined = null;
    const pageLimit = 50; // RPC max
    const maxObjects = 500; // safety cap
    do {
      const { data, nextCursor, hasNextPage } = await client.getOwnedObjects({
        owner,
        filter,
        options: { showContent: true, showType: true },
        limit: pageLimit,
        cursor: cursor ?? undefined,
      });
      if (data && data.length) {
        all.push(...data);
      }
      cursor = hasNextPage ? nextCursor : null;
    } while (cursor && all.length < maxObjects);
    return all;
  }

  // Try MoveModule first; if 0 results, try Package (broader) in case filter differs by node.
  let objects: Awaited<ReturnType<typeof client.getOwnedObjects>>["data"] = [];
  const byModule = await getOwnedObjectsPaginated({
    MoveModule: {
      package: packageId,
      module: MARGIN_MANAGER_MODULE,
    },
  });
  objects = byModule ?? [];
  if (objects.length === 0) {
    const byPackage = await getOwnedObjectsPaginated({ Package: packageId });
    objects = byPackage ?? [];
  }

  console.log("[owned-margin-managers] getOwnedObjects result:", {
    owner: owner.slice(0, 10) + "...",
    packageId,
    objectCount: objects?.length ?? 0,
    objectIds: objects?.map((o) => o.data?.objectId).filter(Boolean) ?? [],
    sampleTypes:
      objects
        ?.slice(0, 3)
        .map((o) => (o.data?.content as Record<string, unknown>)?.type) ?? [],
  });

  const managers: OwnedMarginManagerEntry[] = [];

  if (objects.length === 0) {
    const fromEvents = await getManagersFromCreationEvents(
      client,
      packageId,
      owner
    );
    console.log(
      "[owned-margin-managers] fallback: got managers from creation events:",
      fromEvents.length,
      fromEvents.length > 0 ? fromEvents : ""
    );
    if (fromEvents.length > 0) {
      return { managers: fromEvents };
    }
  }

  for (const obj of objects) {
    if (obj.error || !obj.data?.objectId) {
      console.log(
        "[owned-margin-managers] skip object:",
        obj.error ?? "no objectId",
        obj.data?.objectId
      );
      continue;
    }
    const content = obj.data.content;
    if (
      content?.dataType !== "moveObject" ||
      !content.type?.includes("MarginManager")
    ) {
      console.log(
        "[owned-margin-managers] skip (not MoveObject or not MarginManager):",
        {
          objectId: obj.data.objectId,
          dataType: content?.dataType,
          type: (content as Record<string, unknown>)?.type,
        }
      );
      continue;
    }

    const contentRecord = content as Record<string, unknown>;
    const fields =
      (content.fields as Record<string, unknown> | undefined) ??
      ((contentRecord.data as Record<string, unknown> | undefined)?.fields as
        | Record<string, unknown>
        | undefined);
    const raw =
      fields?.deepbook_pool_id ??
      fields?.deepbook_pool ??
      fields?.pool ??
      fields?.pool_id;
    const deepbookPoolId = normalizePoolId(raw);

    console.log("[owned-margin-managers] MarginManager object:", {
      objectId: obj.data.objectId,
      contentKeys: Object.keys(contentRecord),
      fieldKeys: fields ? Object.keys(fields) : [],
      rawPoolValue: raw,
      extractedPoolId: deepbookPoolId ?? "(none)",
    });

    if (typeof deepbookPoolId === "string" && deepbookPoolId.startsWith("0x")) {
      managers.push({
        margin_manager_id: obj.data.objectId,
        deepbook_pool_id: deepbookPoolId,
      });
    } else {
      managers.push({
        margin_manager_id: obj.data.objectId,
        deepbook_pool_id: "", // unknown pool; app can still use ID with indexer
      });
    }
  }

  return { managers };
}
