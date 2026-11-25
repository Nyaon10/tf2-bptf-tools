import WebSocket from "ws";

// Maximum refined metal above backpack.tf's high base price to allow
const MAX_OVERPAY_REF = 5;

const TF2_QUALITIES: Record<number, string> = {
  0: "Normal",
  1: "Genuine",
  3: "Vintage",
  5: "Unusual",
  6: "Unique",
  7: "Community",
  8: "Valve",
  9: "Self-Made",
  11: "Strange",
  13: "Haunted",
  14: "Collector's",
};

interface WsAttribute {
  defindex: number | string;
  value?: number | string;
  float_value?: number | string;
}

interface WsStrangePart {
  name?: string;
  score?: number;
  killEater?: {
    id?: number;
    name?: string;
  };
}

interface WsListingPayload {
  id: string;
  steamid?: string;
  listedBy?: { id?: string };
  intent: string | number;
  currencies?: {
    keys?: number;
    metal?: number;
  };
  item?: {
    name?: string;
    market_name?: string;
    quality?: number | { id?: number; name?: string };
    craftable?: boolean | number;
    strangeParts?: WsStrangePart[];
    attributes?: WsAttribute[];
  };
}

interface WsEventMessage {
  event: string;
  payload?: WsListingPayload;
}

interface BptfPriceEntry {
  currency: "metal" | "keys";
  value: number;
  value_high?: number;
}

interface BptfPriceItem {
  prices?: Record<
    string,
    {
      Tradable?: {
        Craftable?: BptfPriceEntry[];
        Uncraftable?: BptfPriceEntry[];
      };
    }
  >;
}

interface BptfPriceInfo {
  text: string;
  lowRef: number;
  highRef: number;
}

interface StrangePartEntry {
  id: string;
  partsSummary: string;
  qualityLabel: string;
  itemName: string;
  keys: number;
  metal: number;
  totalRef: number;
  overpayRef: number;
  bptfRange: string;
  sellerId: string;
}

async function fetchBptfPricelist(): Promise<{
  keyRateRef: number;
  items: Record<string, BptfPriceItem>;
  loaded: boolean;
}> {
  const apiKey = process.env.BPTF_API_KEY;
  if (!apiKey) {
    return { keyRateRef: 65, items: {}, loaded: false };
  }

  try {
    const res = await fetch(`https://backpack.tf/api/IGetPrices/v4?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      console.warn(`Warning: IGetPrices/v4 returned HTTP ${res.status}.\n`);
      return { keyRateRef: 65, items: {}, loaded: false };
    }

    const data = (await res.json()) as {
      response?: {
        items?: Record<string, BptfPriceItem>;
      };
    };

    const items = data?.response?.items ?? {};
    const keyPrice = items["Mann Co. Supply Crate Key"]?.prices?.["6"]?.Tradable?.Craftable?.[0]?.value;
    const keyRateRef = typeof keyPrice === "number" && keyPrice > 0 ? keyPrice : 65;

    return { keyRateRef, items, loaded: Object.keys(items).length > 0 };
  } catch {
    console.warn("Warning: Failed to fetch IGetPrices/v4.\n");
    return { keyRateRef: 65, items: {}, loaded: false };
  }
}

function getQualityInfo(item: NonNullable<WsListingPayload["item"]>): {
  id: number;
  label: string;
  isElevatedStrange: boolean;
} {
  const rawQuality = item.quality;
  const id =
    typeof rawQuality === "object" && rawQuality !== null
      ? Number(rawQuality.id ?? 11)
      : Number(rawQuality ?? 11);

  const baseName =
    typeof rawQuality === "object" && rawQuality !== null && rawQuality.name
      ? rawQuality.name
      : TF2_QUALITIES[id] ?? `Quality ${id}`;

  const hasKillEaterAttr =
    Array.isArray(item.attributes) && item.attributes.some((attr) => Number(attr.defindex) === 214);
  const isElevatedStrange = id !== 11 && hasKillEaterAttr;

  const label = isElevatedStrange ? `Strange ${baseName}` : baseName;
  return { id, label, isElevatedStrange };
}

function getStrangePartsFromItem(item: NonNullable<WsListingPayload["item"]>): string[] {
  const parts: string[] = [];

  if (Array.isArray(item.strangeParts)) {
    for (const part of item.strangeParts) {
      const partName = part.killEater?.name ?? part.name;
      if (!partName) continue;
      const scoreSuffix = typeof part.score === "number" ? ` (${part.score})` : "";
      parts.push(`${partName}${scoreSuffix}`);
    }
  }

  if (parts.length === 0 && Array.isArray(item.attributes)) {
    const partSlotDefindexes = new Set([380, 382, 384]);
    for (const attr of item.attributes) {
      if (partSlotDefindexes.has(Number(attr.defindex))) {
        const partTypeId = Number(attr.float_value ?? attr.value);
        if (!Number.isNaN(partTypeId)) {
          parts.push(`Part Type #${partTypeId}`);
        }
      }
    }
  }

  return parts;
}

function hasSkewingModifiers(item: NonNullable<WsListingPayload["item"]>): boolean {
  const quality = getQualityInfo(item);
  if (quality.id === 5) return true; // Exclude Unusuals

  if (!Array.isArray(item.attributes)) return false;
  return item.attributes.some((attr) => {
    const def = Number(attr.defindex);
    return def === 134 || (def >= 1004 && def <= 1009); // Unusual effects & Halloween spells
  });
}

function getBptfPriceInfo(
  items: Record<string, BptfPriceItem>,
  rawItemName: string,
  qualityId: number,
  isCraftable: boolean,
  keyRateRef: number
): BptfPriceInfo | null {
  // Strip quality and killstreak prefixes to match IGetPrices/v4 base item keys
  const baseName = rawItemName
    .replace(/^Strange\s+/i, "")
    .replace(/^(Professional|Specialized)\s+Killstreak\s+/i, "")
    .replace(/^Killstreak\s+/i, "");

  const candidates = [baseName, baseName.replace(/^The\s+/i, ""), `The ${baseName}`];

  let matchedItem: BptfPriceItem | undefined;
  for (const candidate of candidates) {
    if (items[candidate]) {
      matchedItem = items[candidate];
      break;
    }
  }

  if (!matchedItem) return null;

  const craftBucket = isCraftable ? "Craftable" : "Uncraftable";
  const entries =
    matchedItem.prices?.[String(qualityId)]?.Tradable?.[craftBucket] ??
    matchedItem.prices?.["11"]?.Tradable?.[craftBucket];

  if (!Array.isArray(entries) || entries.length === 0) return null;

  const entry = entries[0];
  const low = entry.value;
  const high = typeof entry.value_high === "number" && entry.value_high > low ? entry.value_high : low;
  const hasRange = high > low;

  if (entry.currency === "keys") {
    const lowRef = low * keyRateRef;
    const highRef = high * keyRateRef;
    const text = hasRange
      ? `${low}–${high} keys (~${lowRef.toFixed(2)}–${highRef.toFixed(2)} ref)`
      : `${low} ${low === 1 ? "key" : "keys"} (~${lowRef.toFixed(2)} ref)`;
    return { text, lowRef, highRef };
  }

  const text = hasRange ? `${low.toFixed(2)}–${high.toFixed(2)} ref` : `${low.toFixed(2)} ref`;
  return { text, lowRef: low, highRef: high };
}

function formatPrice(keys: number, metal: number): string {
  const parts: string[] = [];
  if (keys > 0) parts.push(`${keys} ${keys === 1 ? "key" : "keys"}`);
  if (metal > 0 || parts.length === 0) parts.push(`${metal.toFixed(2)} ref`);
  return parts.join(", ");
}

function formatDiff(diffRef: number): string {
  const sign = diffRef >= 0 ? "+" : "";
  return `${sign}${diffRef.toFixed(2)} ref`;
}

function printSortedResults(collected: Map<string, StrangePartEntry>, heading: string) {
  const sorted = Array.from(collected.values()).sort((a, b) => a.totalRef - b.totalRef);

  console.log(`\n=== ${heading} (${sorted.length} found, <= +${MAX_OVERPAY_REF} ref over bptf list) ===`);
  if (sorted.length === 0) {
    console.log(`No Strange listings with attached Strange Parts within +${MAX_OVERPAY_REF} ref captured yet.`);
    return;
  }

  sorted.forEach((entry, index) => {
    const priceStr = formatPrice(entry.keys, entry.metal);
    console.log(
      `${index + 1}. [${entry.partsSummary}] [${entry.qualityLabel}] ${entry.itemName} — Listed: ${priceStr} (~${entry.totalRef.toFixed(2)} ref, ${formatDiff(entry.overpayRef)}) | bptf list: ${entry.bptfRange} | Seller: ${entry.sellerId}`
    );
  });
  console.log("========================================================================\n");
}

async function main() {
  const rawArg = process.argv[2];
  const filterName = rawArg && rawArg.toLowerCase() !== "all" ? rawArg : undefined;
  const collectSeconds = process.argv[3] ? Number(process.argv[3]) : undefined;

  console.log("Loading backpack.tf pricelist...");
  const { keyRateRef, items: priceItems, loaded: pricelistLoaded } = await fetchBptfPricelist();

  if (!pricelistLoaded) {
    console.error("Error: BPTF_API_KEY must be set to compare listings against backpack.tf base prices.");
    process.exit(1);
  }

  const collected = new Map<string, StrangePartEntry>();
  let retryDelayMs = 5000;
  let activeWs: WebSocket | null = null;
  let isShuttingDown = false;

  const connect = () => {
    const ws = new WebSocket("wss://ws.backpack.tf/events", {
      headers: {
        Origin: "https://backpack.tf",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    activeWs = ws;

    ws.on("open", () => {
      retryDelayMs = 5000;
      const scope = filterName ? `matching "${filterName}"` : "across all cosmetics & weapons";
      const timerNote = collectSeconds
        ? `Collecting for ${collectSeconds} seconds...`
        : "Press Ctrl + C at any time to stop and view the final sorted list.";
      console.log(
        `Connected (1 key = ${keyRateRef} ref). Filtering Strange items with Strange Parts <= +${MAX_OVERPAY_REF} ref over bptf price ${scope}.`
      );
      console.log(`${timerNote}\n`);
    });

    ws.on("message", (rawData) => {
      let parsed: WsEventMessage | WsEventMessage[];
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      const events = Array.isArray(parsed) ? parsed : [parsed];
      let updated = false;

      for (const msg of events) {
        if (msg.event !== "listing-update" || !msg.payload?.item) continue;

        const listing = msg.payload;
        const isSell = listing.intent === "sell" || listing.intent === 1;
        if (!isSell) continue;

        const item = listing.item!;
        const rawName = item.name ?? item.market_name ?? "Unknown Item";

        if (filterName && !rawName.toLowerCase().includes(filterName.toLowerCase())) {
          continue;
        }

        if (hasSkewingModifiers(item)) continue;

        const strangeParts = getStrangePartsFromItem(item);
        if (strangeParts.length === 0) continue;

        const quality = getQualityInfo(item);
        const cleanName = rawName.startsWith("Strange ") ? rawName.slice("Strange ".length) : rawName;

        const isCraftable = item.craftable !== false && item.craftable !== 0;
        const bptfPrice = getBptfPriceInfo(
          priceItems,
          cleanName,
          quality.id,
          isCraftable,
          keyRateRef
        );

        // Skip unpriced items since we cannot verify the +5 ref limit
        if (!bptfPrice) continue;

        const keys = listing.currencies?.keys ?? 0;
        const metal = listing.currencies?.metal ?? 0;
        const totalRef = keys * keyRateRef + metal;

        // Compare against the upper end of backpack.tf's community range
        const overpayRef = totalRef - bptfPrice.highRef;
        if (overpayRef > MAX_OVERPAY_REF + 0.001) continue;

        const sellerId = listing.steamid ?? listing.listedBy?.id ?? "Unknown";

        collected.set(listing.id, {
          id: listing.id,
          partsSummary: strangeParts.join(", "),
          qualityLabel: quality.label,
          itemName: cleanName,
          keys,
          metal,
          totalRef,
          overpayRef,
          bptfRange: bptfPrice.text,
          sellerId,
        });
        updated = true;
      }

      if (updated && !collectSeconds) {
        printSortedResults(collected, "Live Cheap Strange Items with Parts");
      }
    });

    ws.on("error", (err) => {
      if (!isShuttingDown) console.error(`WebSocket error: ${err.message}`);
    });

    ws.on("close", (code, reason) => {
      if (isShuttingDown) return;
      const reasonText = reason.toString() || "No reason given";
      const nextDelaySec = Math.round(retryDelayMs / 1000);
      console.log(`Stream closed (code ${code}: ${reasonText}). Reconnecting in ${nextDelaySec}s...`);
      setTimeout(() => {
        retryDelayMs = Math.min(retryDelayMs * 2, 60000);
        connect();
      }, retryDelayMs);
    });
  };

  const shutdown = (label: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    activeWs?.close();
    printSortedResults(collected, label);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("Final Cheap Strange Items with Parts"));

  if (collectSeconds && !Number.isNaN(collectSeconds) && collectSeconds > 0) {
    setTimeout(() => shutdown(`Sorted Results After ${collectSeconds}s`), collectSeconds * 1000);
  }

  connect();
}

main();