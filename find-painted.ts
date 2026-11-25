import WebSocket from "ws";

// Maximum refined metal above backpack.tf's high base price to allow
const MAX_OVERPAY_REF = 5;

const TF2_PAINTS: Record<number, string> = {
  3100495: "A Color Similar to Slate",
  8208497: "A Deep Commitment to Purple",
  1315860: "A Distinctive Lack of Hue",
  12377523: "A Mann's Mint",
  2960676: "After Eight",
  8289918: "Aged Moustache Grey",
  6637376: "An Air of Debonair",
  15132390: "An Extraordinary Abundance of Tinge",
  15185211: "Australium Gold",
  3874595: "Balaclavas Are Forever",
  14204632: "Color No. 216-190-216",
  12807213: "Cream Spirit",
  15308410: "Dark Salmon Injustice",
  8421376: "Drably Olive",
  7511618: "Indubitably Green",
  13595446: "Mann Co. Orange",
  10843461: "Muskelmannbraun",
  5322826: "Noble Hatter's Violet",
  4732984: "Operator's Overalls",
  12955537: "Peculiarly Drab Tincture",
  16738740: "Pink as Hell",
  6901050: "Radigan Conagher Brown",
  12073019: "Team Spirit",
  3329330: "The Bitter Taste of Defeat and Lime",
  15787660: "The Color of a Gentlemann's Business Pants",
  8400928: "The Value of Teamwork",
  11049612: "Waterlogged Lab Coat",
  8154199: "Ye Olde Rustic Colour",
  4345659: "Zepheniah's Greed",
};

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
    paint?: { id?: number; name?: string };
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

interface PaintedEntry {
  id: string;
  paintName: string;
  qualityName: string;
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
        success?: number;
        message?: string;
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

function getBptfPriceInfo(
  items: Record<string, BptfPriceItem>,
  itemName: string,
  qualityId: number,
  isCraftable: boolean,
  keyRateRef: number
): BptfPriceInfo | null {
  const candidates = [
    itemName,
    itemName.replace(/^The\s+/i, ""),
    `The ${itemName}`,
  ];

  let matchedItem: BptfPriceItem | undefined;
  for (const candidate of candidates) {
    if (items[candidate]) {
      matchedItem = items[candidate];
      break;
    }
  }

  if (!matchedItem) return null;

  const craftBucket = isCraftable ? "Craftable" : "Uncraftable";
  const entries = matchedItem.prices?.[String(qualityId)]?.Tradable?.[craftBucket];
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

function getQualityInfo(quality?: number | { id?: number; name?: string }): { id: number; name: string } {
  if (typeof quality === "object" && quality !== null) {
    const id = Number(quality.id ?? 6);
    return {
      id,
      name: quality.name ?? TF2_QUALITIES[id] ?? `Quality ${id}`,
    };
  }

  const id = Number(quality ?? 6);
  return {
    id,
    name: TF2_QUALITIES[id] ?? `Quality ${id}`,
  };
}

function getPaintFromItem(item: NonNullable<WsListingPayload["item"]>): { id: number; name: string } | null {
  if (Array.isArray(item.attributes)) {
    for (const attr of item.attributes) {
      if (Number(attr.defindex) === 142) {
        const paintId = Number(attr.float_value ?? attr.value);
        if (!Number.isNaN(paintId)) {
          return {
            id: paintId,
            name: TF2_PAINTS[paintId] ?? `Unknown Paint (${paintId})`,
          };
        }
      }
    }
  }

  if (item.paint?.name) {
    return {
      id: item.paint.id ?? 0,
      name: item.paint.name,
    };
  }

  return null;
}

function hasSkewingModifiers(item: NonNullable<WsListingPayload["item"]>): boolean {
  const quality = getQualityInfo(item.quality);
  if (quality.id === 5) return true;

  if (!Array.isArray(item.attributes)) return false;
  return item.attributes.some((attr) => {
    const def = Number(attr.defindex);
    return def === 134 || (def >= 1004 && def <= 1009);
  });
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

function printSortedResults(collected: Map<string, PaintedEntry>, heading: string) {
  const sorted = Array.from(collected.values()).sort((a, b) => a.totalRef - b.totalRef);

  console.log(`\n=== ${heading} (${sorted.length} found, <= +${MAX_OVERPAY_REF} ref over bptf list) ===`);
  if (sorted.length === 0) {
    console.log(`No matching painted listings within +${MAX_OVERPAY_REF} ref captured yet.`);
    return;
  }

  sorted.forEach((entry, index) => {
    const priceStr = formatPrice(entry.keys, entry.metal);
    console.log(
      `${index + 1}. [${entry.paintName}] [${entry.qualityName}] ${entry.itemName} — Listed: ${priceStr} (~${entry.totalRef.toFixed(2)} ref, ${formatDiff(entry.overpayRef)}) | bptf list: ${entry.bptfRange} | Seller: ${entry.sellerId}`
    );
  });
  console.log("========================================================================\n");
}

async function main() {
  const arg2 = process.argv[2];
  const arg3 = process.argv[3];
  const arg4 = process.argv[4];

  const filterName = arg2 && arg2.toLowerCase() !== "all" ? arg2 : undefined;

  // Support both `node find-painted.ts all 60` and `node find-painted.ts all gold 60`
  let filterPaint: string | undefined;
  let collectSeconds: number | undefined;

  if (arg3 && /^\d+$/.test(arg3)) {
    collectSeconds = Number(arg3);
  } else {
    if (arg3 && arg3.toLowerCase() !== "all") {
      filterPaint = arg3;
    }
    if (arg4 && /^\d+$/.test(arg4)) {
      collectSeconds = Number(arg4);
    }
  }

  console.log("Loading backpack.tf pricelist...");
  const { keyRateRef, items: priceItems, loaded: pricelistLoaded } = await fetchBptfPricelist();

  if (!pricelistLoaded) {
    console.error("Error: BPTF_API_KEY must be set to compare listings against backpack.tf base prices.");
    process.exit(1);
  }

  const collected = new Map<string, PaintedEntry>();
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
      const itemScope = filterName ? `matching "${filterName}"` : "across all cosmetics";
      const paintScope = filterPaint ? `painted "${filterPaint}"` : "in any paint";
      const timerNote = collectSeconds
        ? `Collecting for ${collectSeconds} seconds...`
        : "Press Ctrl + C at any time to stop and view the final sorted list.";
      console.log(
        `Connected (1 key = ${keyRateRef} ref). Filtering ${paintScope} (${itemScope}) <= +${MAX_OVERPAY_REF} ref over bptf price.`
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

        const paint = getPaintFromItem(item);
        if (!paint) continue;

        if (filterPaint && !paint.name.toLowerCase().includes(filterPaint.toLowerCase())) {
          continue;
        }

        const quality = getQualityInfo(item.quality);
        const cleanName = rawName.startsWith(`${quality.name} `)
          ? rawName.slice(quality.name.length + 1)
          : rawName;

        const isCraftable = item.craftable !== false && item.craftable !== 0;
        const bptfPrice = getBptfPriceInfo(
          priceItems,
          cleanName,
          quality.id,
          isCraftable,
          keyRateRef
        );

        if (!bptfPrice) continue;

        const keys = listing.currencies?.keys ?? 0;
        const metal = listing.currencies?.metal ?? 0;
        const totalRef = keys * keyRateRef + metal;

        const overpayRef = totalRef - bptfPrice.highRef;
        if (overpayRef > MAX_OVERPAY_REF + 0.001) continue;

        const sellerId = listing.steamid ?? listing.listedBy?.id ?? "Unknown";

        collected.set(listing.id, {
          id: listing.id,
          paintName: paint.name,
          qualityName: quality.name,
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
        printSortedResults(collected, "Live Cheap Painted Listings");
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

  process.on("SIGINT", () => shutdown("Final Cheap Painted Listings"));

  if (collectSeconds && !Number.isNaN(collectSeconds) && collectSeconds > 0) {
    setTimeout(() => shutdown(`Sorted Results After ${collectSeconds}s`), collectSeconds * 1000);
  }

  connect();
}

main();