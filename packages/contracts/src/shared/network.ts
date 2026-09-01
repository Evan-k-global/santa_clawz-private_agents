function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeGraphqlEndpoint(value: string): string {
  const trimmed = trimTrailingSlash(value.trim());
  if (!trimmed) {
    return trimmed;
  }

  return trimmed.endsWith("/graphql") ? trimmed : `${trimmed}/graphql`;
}

export function o1jsNetworkIdForZekoNetwork(networkId: string, override?: string): string {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) {
    return trimmedOverride;
  }

  const normalized = networkId.trim().toLowerCase();
  if (normalized.includes("sepolia") || normalized === "zeko:testnet" || normalized === "testnet") {
    return "testnet";
  }

  return networkId;
}
