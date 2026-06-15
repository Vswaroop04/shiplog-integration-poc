import { SyncResult } from "../types";

export interface IntegrationAdapter {
  name: string;
  linesOfAdapterCode: number;
  sync(owner: string, repo: string): Promise<SyncResult>;
}
