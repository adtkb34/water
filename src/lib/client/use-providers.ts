"use client";

import useSWR from "swr";
import { fetchJson } from "@/lib/client/api";
import type { ProviderList } from "@/lib/providers/public";

export function useProviderList() {
  const { data, error, isLoading, mutate } = useSWR<ProviderList>(
    "/api/providers",
    fetchJson,
    { revalidateOnFocus: true },
  );
  return { data, error, isLoading, refresh: () => mutate() };
}
