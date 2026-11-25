import WebSocket from "ws";

// Minimum profit in refined metal required to display a match (set to 0.01 for any profit)
const MIN_PROFIT_REF = 0.01;

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
    baseName?: string;
    market_name?: string;
    quality?: number | { id?: number; name?: string };
    quality2?: number | { id?: number; name?: string };
    elevated?: boolean | number | string;
    craftable?: boolean | number;
    australium?: boolean | number;
    particle?: { id?: number; name?: string };
    attributes?: WsAttribute[];
  };
}

interface WsEventMessage {
  event: string;
  payload?: WsListingPayload | string;
}

interface BptfPriceItem {
  prices?: Record<
    string,
    {
      Tradable?: {
        Craftable?: Array<{ value: number }>;
      };
    }
  >;
}

interface UnusualOrder {
  id: string;
  intent: "sell" | "buy";
  matchKey: string;
  baseName: string;
  effectName: string;
  effectId: number;
  isStrange: boolean;
  isCraftable: boolean;
  keys: number;
  metal: number;
  totalRef: number;
  userId: string;
  updatedAt: number;
}

interface ArbitrageMatch {
  matchKey: string;
  baseName: string;
  effectName: string;
  isStrange: boolean;
  isCraftable: boolean;
  lowestSell: UnusualOrder;
  highestBuy: UnusualOrder;
  profitRef: number;
  profitKeys: number;
}

interface CliOptions {
  filterName?: string;
  collectSeconds?: number;
  maxKeys?: number;
  maxRef?: number;
}

function parseCliArgs(args: string[]): CliOptions {
  const positional: string[] = [];
  let maxKeys: number | undefined;
  let maxRef: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--keys" || arg === "-k") {
      const val = Number(args[++i]);
      if (!Number.isNaN(val) && val >= 0) maxKeys = val;
    } else if (arg.startsWith("--keys=")) {
      const val = Number(arg.split("=")[1]);
      if (!Number.isNaN(val) && val >= 0) maxKeys = val;
    } else if (arg === "--ref" || arg === "-r") {
      const val = Number(args[++i]);
      if (!Number.isNaN(val) && val >= 0) maxRef = val;
    } else if (arg.startsWith("--ref=")) {
      const val = Number(arg.split("=")[1]);
      if (!Number.isNaN(val) && val >= 0) maxRef = val;
    } else {
      positional.push(arg);
    }
  }

  const rawFilter = positional[0];
  const filterName = rawFilter && rawFilter.toLowerCase() !== "all" ? rawFilter : undefined;
  const collectSeconds =
    positional[1] && !Number.isNaN(Number(positional[1])) ? Number(positional[1]) : undefined;

  return { filterName, collectSeconds, maxKeys, maxRef };
}

async function fetchLiveKeyPriceRef(): Promise<number> {
  const apiKey = process.env.BPTF_API_KEY;
  if (!apiKey) return 65;

  try {
    const res = await fetch(`https://backpack.tf/api/IGetPrices/v4?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) return 65;
    const data = (await res.json()) as {
      response?: { items?: Record<string, BptfPriceItem> };
    };
    const keyPrice =
      data?.response?.items?.["Mann Co. Supply Crate Key"]?.prices?.["6"]?.Tradable?.Craftable?.[0]?.value;
    return typeof keyPrice === "number" && keyPrice > 0 ? keyPrice : 65;
  } catch {
    return 65;
  }
}

function isUnusualQuality(quality?: number | { id?: number; name?: string }): boolean {
  if (typeof quality === "object" && quality !== null) {
    return Number(quality.id) === 5;
  }
  return Number(quality) === 5;
}

function isStrangeUnusual(item: NonNullable<WsListingPayload["item"]>): boolean {
  // 1. backpack.tf elevated quality flag (e.g. elevated: true or 11)
  if (item.elevated === true || Number(item.elevated) === 11 || item.elevated === "Strange") {
    return true;
  }

  // 2. Secondary quality field (quality2 = 11 for Strange)
  if (typeof item.quality2 === "object" && item.quality2 !== null) {
    if (Number(item.quality2.id) === 11) return true;
  } else if (Number(item.quality2) === 11) {
    return true;
  }

  // 3. Raw TF2 Kill-Eater attribute (defindex 214)
  if (
    Array.isArray(item.attributes) &&
    item.attributes.some((attr) => Number(attr.defindex) === 214)
  ) {
    return true;
  }

  // 4. Item display name prefix fallback
  const rawName = (item.name ?? item.market_name ?? "").trim().toLowerCase();
  if (rawName.startsWith("strange ")) {
    return true;
  }

  return false;
}

function getEffectInfo(item: NonNullable<WsListingPayload["item"]>): { id: number; name: string } | null {
  if (item.particle && typeof item.particle.id === "number" && item.particle.id > 0) {
    return {
      id: item.particle.id,
      name: item.particle.name ?? `Effect #${item.particle.id}`,
    };
  }

  if (Array.isArray(item.attributes)) {
    for (const attr of item.attributes) {
      if (Number(attr.defindex) === 134) {
        const effectId = Number(attr.float_value ?? attr.value);
        if (!Number.isNaN(effectId) && effectId > 0) {
          return {
            id: effectId,
            name: item.particle?.name ?? `Effect #${effectId}`,
          };
        }
      }
    }
  }

  return null;
}

function getCleanBaseName(
  item: NonNullable<WsListingPayload["item"]>,
  effectName: string
): string {
  if (item.baseName && item.baseName.trim().length > 0) {
    return item.baseName.trim();
  }

  let name = (item.name ?? item.market_name ?? "Unknown Item").trim();
  if (name.startsWith("Strange ")) {
    name = name.slice("Strange ".length);
  }
  if (name.startsWith("Unusual ")) {
    name = name.slice("Unusual ".length);
  }
  if (effectName && !effectName.startsWith("Effect #") && name.startsWith(`${effectName} `)) {
    name = name.slice(effectName.length + 1);
  }
  return name.trim();
}

function formatPrice(keys: number, metal: number): string {
  const parts: string[] = [];
  if (keys > 0) parts.push(`${keys} ${keys === 1 ? "key" : "keys"}`);
  if (metal > 0 || parts.length === 0) parts.push(`${metal.toFixed(2)} ref`);
  return parts.join(", ");
}

function findArbitrageMatches(
  sellOrders: Map<string, UnusualOrder>,
  buyOrders: Map<string, UnusualOrder>,
  keyRateRef: number,
  maxBudgetRef: number | null
): ArbitrageMatch[] {
  const lowestSellByKey = new Map<string, UnusualOrder>();
  for (const sell of sellOrders.values()) {
    if (maxBudgetRef !== null && sell.totalRef > maxBudgetRef + 0.001) {
      continue;
    }

    const existing = lowestSellByKey.get(sell.matchKey);
    if (!existing || sell.totalRef < existing.totalRef) {
      lowestSellByKey.set(sell.matchKey, sell);
    }
  }

  const highestBuyByKey = new Map<string, UnusualOrder>();
  for (const buy of buyOrders.values()) {
    const existing = highestBuyByKey.get(buy.matchKey);
    if (!existing || buy.totalRef > existing.totalRef) {
      highestBuyByKey.set(buy.matchKey, buy);
    }
  }

  const matches: ArbitrageMatch[] = [];

  for (const [matchKey, lowestSell] of lowestSellByKey.entries()) {
    const highestBuy = highestBuyByKey.get(matchKey);
    if (!highestBuy) continue;

    if (lowestSell.userId !== "Unknown" && lowestSell.userId === highestBuy.userId) {
      continue;
    }

    const profitRef = highestBuy.totalRef - lowestSell.totalRef;
    if (profitRef >= MIN_PROFIT_REF) {
      matches.push({
        matchKey,
        baseName: lowestSell.baseName,
        effectName: lowestSell.effectName,
        isStrange: lowestSell.isStrange,
        isCraftable: lowestSell.isCraftable,
        lowestSell,
        highestBuy,
        profitRef,
        profitKeys: profitRef / keyRateRef,
      });
    }
  }

  return matches.sort((a, b) => b.profitRef - a.profitRef);
}

function printArbitrageReport(
  sellOrders: Map<string, UnusualOrder>,
  buyOrders: Map<string, UnusualOrder>,
  keyRateRef: number,
  maxBudgetRef: number | null,
  heading: string
) {
  const matches = findArbitrageMatches(sellOrders, buyOrders, keyRateRef, maxBudgetRef);

  console.log(
    `\n=== ${heading} | Tracked Unusuals: ${sellOrders.size} sells, ${buyOrders.size} buys ===`
  );

  if (matches.length === 0) {
    console.log("No profitable buy > sell overlaps within your budget found yet...");
    console.log("================================================================================\n");
    return;
  }

  matches.forEach((m, index) => {
    const strangeTag = m.isStrange ? " [Strange]" : "";
    const craftTag = m.isCraftable ? "" : " [Uncraftable]";
    const sellStr = formatPrice(m.lowestSell.keys, m.lowestSell.metal);
    const buyStr = formatPrice(m.highestBuy.keys, m.highestBuy.metal);
    const leftOverNote =
      maxBudgetRef !== null
        ? ` | Leftover budget: ${(maxBudgetRef - m.lowestSell.totalRef).toFixed(2)} ref`
        : "";

    console.log(
      `${index + 1}. [${m.effectName}]${strangeTag} ${m.baseName}${craftTag} — Profit: +${m.profitRef.toFixed(2)} ref (+${m.profitKeys.toFixed(2)} keys)`
    );
    console.log(
      `   BUY FROM Seller (${m.lowestSell.userId}): ${sellStr} (~${m.lowestSell.totalRef.toFixed(2)} ref)${leftOverNote}`
    );
    console.log(
      `   SELL TO  Buyer  (${m.highestBuy.userId}): ${buyStr} (~${m.highestBuy.totalRef.toFixed(2)} ref)`
    );
  });

  console.log("================================================================================\n");
}

async function main() {
  const { filterName, collectSeconds, maxKeys, maxRef } = parseCliArgs(process.argv.slice(2));
  const keyRateRef = await fetchLiveKeyPriceRef();

  const hasBudget = maxKeys !== undefined || maxRef !== undefined;
  const budgetKeys = maxKeys ?? 0;
  const budgetMetal = maxRef ?? 0;
  const maxBudgetRef = hasBudget ? budgetKeys * keyRateRef + budgetMetal : null;

  const sellOrders = new Map<string, UnusualOrder>();
  const buyOrders = new Map<string, UnusualOrder>();

  let retryDelayMs = 5000;
  let activeWs: WebSocket | null = null;
  let isShuttingDown = false;
  let lastMatchSignature = "";

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
      const scope = filterName ? `matching "${filterName}"` : "across all Unusuals";
      const budgetText =
        maxBudgetRef !== null
          ? `Budget cap: ${formatPrice(budgetKeys, budgetMetal)} (~${maxBudgetRef.toFixed(2)} ref total)`
          : "Budget cap: Unlimited";
      const timerNote = collectSeconds
        ? `Collecting live order book for ${collectSeconds} seconds...`
        : "Press Ctrl + C at any time to stop and view the final report.";

      console.log(`Connected (1 key = ${keyRateRef} ref). Monitoring Unusual buy vs. sell orders ${scope}.`);
      console.log(`${budgetText}. ${timerNote}\n`);
    });

    ws.on("message", (rawData) => {
      let parsed: WsEventMessage | WsEventMessage[];
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      const events = Array.isArray(parsed) ? parsed : [parsed];
      let bookChanged = false;

      for (const msg of events) {
        if (msg.event === "listing-delete" || msg.event === "listing-remove") {
          const deletedId = typeof msg.payload === "string" ? msg.payload : msg.payload?.id;
          if (deletedId) {
            const removedSell = sellOrders.delete(deletedId);
            const removedBuy = buyOrders.delete(deletedId);
            if (removedSell || removedBuy) bookChanged = true;
          }
          continue;
        }

        if (msg.event !== "listing-update" || !msg.payload || typeof msg.payload === "string") {
          continue;
        }

        const listing = msg.payload;
        const item = listing.item;
        if (!item || !isUnusualQuality(item.quality)) continue;

        const effect = getEffectInfo(item);
        if (!effect) continue;

        const isStrange = isStrangeUnusual(item);
        const baseName = getCleanBaseName(item, effect.name);
        const fullSearchText = `${isStrange ? "strange " : ""}${effect.name} ${baseName}`.toLowerCase();

        if (filterName && !fullSearchText.includes(filterName.toLowerCase())) {
          continue;
        }

        const isSell = listing.intent === "sell" || listing.intent === 1;
        const isBuy = listing.intent === "buy" || listing.intent === 0;
        if (!isSell && !isBuy) continue;

        const keys = listing.currencies?.keys ?? 0;
        const metal = listing.currencies?.metal ?? 0;
        const totalRef = keys * keyRateRef + metal;
        if (totalRef <= 0) continue;

        const isCraftable = item.craftable !== false && item.craftable !== 0;
        const isAustralium = Boolean(item.australium);
        const matchKey = `${baseName.toLowerCase()}|effect:${effect.id}|strange:${isStrange}|craft:${isCraftable}|aus:${isAustralium}`;
        const userId = listing.steamid ?? listing.listedBy?.id ?? "Unknown";

        const order: UnusualOrder = {
          id: listing.id,
          intent: isSell ? "sell" : "buy",
          matchKey,
          baseName,
          effectName: effect.name,
          effectId: effect.id,
          isStrange,
          isCraftable,
          keys,
          metal,
          totalRef,
          userId,
          updatedAt: Date.now(),
        };

        if (isSell) {
          sellOrders.set(listing.id, order);
        } else {
          buyOrders.set(listing.id, order);
        }
        bookChanged = true;
      }

      if (bookChanged && !collectSeconds) {
        const currentMatches = findArbitrageMatches(sellOrders, buyOrders, keyRateRef, maxBudgetRef);
        const signature = currentMatches
          .map((m) => `${m.lowestSell.id}->${m.highestBuy.id}:${m.profitRef.toFixed(2)}`)
          .join("|");

        if (signature !== lastMatchSignature) {
          lastMatchSignature = signature;
          printArbitrageReport(
            sellOrders,
            buyOrders,
            keyRateRef,
            maxBudgetRef,
            "Live Unusual Arbitrage Opportunities"
          );
        }
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

  const statusInterval = setInterval(() => {
    if (!isShuttingDown) {
      console.log(
        `[Status] Order book size: ${sellOrders.size} Unusual sell orders, ${buyOrders.size} Unusual buy orders...`
      );
    }
  }, 30000);

  const shutdown = (label: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(statusInterval);
    activeWs?.close();
    printArbitrageReport(sellOrders, buyOrders, keyRateRef, maxBudgetRef, label);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("Final Unusual Arbitrage Report"));

  if (collectSeconds && !Number.isNaN(collectSeconds) && collectSeconds > 0) {
    setTimeout(() => shutdown(`Unusual Arbitrage Report After ${collectSeconds}s`), collectSeconds * 1000);
  }

  connect();
}

main();