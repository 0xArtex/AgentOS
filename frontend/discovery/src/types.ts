export interface ToolProvider {
  id: string;
  name: string;
  network: string;
  networkLabel: string;
  costUsdc: number;
  method: string;
  endpoint: string;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  category: string;
  categoryLabel: string;
  path: string;
  networks: string[];
  networkLabels: string[];
  minCostUsdc: number;
  maxCostUsdc: number;
  providerCount: number;
  providers: ToolProvider[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  isCompound: boolean;
}

export interface DiscoveryResponse {
  stats: {
    totalTools: number;
    totalProviders: number;
    totalCategories: number;
    totalNetworks: number;
  };
  categories: Array<{ key: string; label: string }>;
  networks: Array<{ key: string; label: string }>;
  tools: Tool[];
}
