import { capabilities } from "@/lib/contract/registry";
import type { Policy, RefKind, Store } from "@/lib/contract/types";
import { daysFromToday, isoDaysFromToday } from "@/lib/dates";
import { REF_KINDS } from "@/lib/domain";

// Route handlers can load this module more than once in dev; the store has to live on globalThis.
const GLOBAL_KEY = "__agentNativeStore";

type GlobalWithStore = typeof globalThis & {
  [GLOBAL_KEY]?: Store;
};

export function defaultPolicy(): Policy {
  return {
    threshold: 6,
    alwaysReview: capabilities
      .filter((capability) => capability.alwaysReview)
      .map((capability) => capability.id),
  };
}

function emptyStore(): Store {
  return {
    products: [],
    suppliers: [],
    inquiries: [],
    counters: { product: 0, supplier: 0, inquiry: 0 },
    policy: { threshold: 6, alwaysReview: [] },
    approvals: [],
    audit: [],
    seq: { approval: 0, audit: 0 },
  };
}

export function allocateId(store: Store, kind: RefKind): string {
  const { prefix } = REF_KINDS[kind];
  store.counters[kind] += 1;
  return `${prefix}-${String(store.counters[kind]).padStart(3, "0")}`;
}

export function removeAllocated<T extends { id: string }>(
  list: T[],
  id: string,
): void {
  const index = list.findIndex((item) => item.id === id);
  if (index >= 0) list.splice(index, 1);
}

function buildSeed(now = new Date()): Store {
  const store = emptyStore();
  const products = [
    { name: "不锈钢螺栓", category: "五金", unit: "件", referencePrice: 0.85 },
    { name: "镀锌螺母", category: "五金", unit: "个", referencePrice: 0.42 },
    { name: "贴片电阻", category: "电子", unit: "个", referencePrice: 0.15 },
    { name: "直流电机", category: "电子", unit: "台", referencePrice: 128 },
    { name: "瓦楞纸箱", category: "包材", unit: "个", referencePrice: 3.6 },
    { name: "聚乙烯颗粒", category: "原料", unit: "千克", referencePrice: 9.8 },
  ];
  for (const product of products) {
    store.products.push({ id: allocateId(store, "product"), ...product });
  }

  const suppliers = [
    { name: "沪上紧固件", categories: ["五金"], rating: 4.7 },
    { name: "芯联电子", categories: ["电子"], rating: 4.5 },
    { name: "包装通", categories: ["包材"], rating: 4.2 },
    { name: "原材行", categories: ["原料"], rating: 4.4 },
    {
      name: "联采商行",
      categories: ["五金", "电子", "包材", "原料"],
      rating: 4,
    },
  ];
  for (const supplier of suppliers) {
    store.suppliers.push({ id: allocateId(store, "supplier"), ...supplier });
  }

  store.inquiries.push({
    id: allocateId(store, "inquiry"),
    productId: "P-001",
    quantity: 2000,
    deadline: daysFromToday(21, now),
    supplierIds: ["S-001", "S-005"],
    note: "月度补货",
    status: "draft",
    createdAt: isoDaysFromToday(-3, now),
  });
  store.inquiries.push({
    id: allocateId(store, "inquiry"),
    productId: "P-003",
    quantity: 10000,
    deadline: daysFromToday(10, now),
    supplierIds: ["S-002", "S-005"],
    status: "published",
    createdAt: isoDaysFromToday(-1, now),
  });
  store.policy = defaultPolicy();
  return store;
}

function globalStore(): GlobalWithStore {
  return globalThis as GlobalWithStore;
}

export function getStore(): Store {
  const holder = globalStore();
  if (!holder[GLOBAL_KEY]) {
    holder[GLOBAL_KEY] = buildSeed();
  }
  return holder[GLOBAL_KEY];
}

export function reset(): Store {
  const next = buildSeed();
  const current = getStore();
  current.products.splice(0, current.products.length, ...next.products);
  current.suppliers.splice(0, current.suppliers.length, ...next.suppliers);
  current.inquiries.splice(0, current.inquiries.length, ...next.inquiries);
  current.counters.product = next.counters.product;
  current.counters.supplier = next.counters.supplier;
  current.counters.inquiry = next.counters.inquiry;
  current.policy = {
    threshold: next.policy.threshold,
    alwaysReview: [...next.policy.alwaysReview],
  };
  current.approvals.splice(0, current.approvals.length);
  current.audit.splice(0, current.audit.length);
  current.seq.approval = 0;
  current.seq.audit = 0;
  return current;
}
