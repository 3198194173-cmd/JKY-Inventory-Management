export const xingkongBaseUrl = 'https://benks.ik3cloud.com/k3cloud/';
export type XingkongKind = 'companySales' | 'companyStock';
export type XingkongSettings = { start: string; end: string; salesOrganization: string; settleOrganization: string; schemeId: string };
export type XingkongOrganization = { id: string; code: string; name: string };
export type XingkongProbe = {
  id: string; createdAt: string; kind: XingkongKind; accountId: string; endpoint: string;
  request: Record<string, unknown>; columns: { field: string; label: string }[];
  rows: Record<string, string | boolean | null>[]; total: number; returnedRows: number; durationMs: number;
  queryIdReceived: boolean; organizations: XingkongOrganization[];
  customerExclusions: string[];
  rowNotes: { row: number; displayTotal: boolean; excludedCustomer: boolean }[];
  warnings: string[]; sampleOnly: true; apiReadComplete: false; uiEquivalentVerified: false;
};
