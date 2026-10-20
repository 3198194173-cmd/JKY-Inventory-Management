import type { Metadata } from 'next';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import InventoryDashboard from '@/components/inventory-dashboard';
import { EmptyWorkspace } from '@/components/empty-workspace';
import { currentContext } from '@/lib/auth';
import { loadInventory, loadWarehouses } from '@/lib/inventory-store';
import { settings } from '@/lib/alerts-store';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '吉客云 · 仓库数据' };

export default async function JackyunPage() {
  await requireChatGPTUser('/jackyun');
  const { actor, target } = await currentContext();
  const profile = { id: actor.id, name: actor.display_name, role: actor.role, targetId: target.id, targetName: target.display_name };
  const warehouses = await loadWarehouses(target.data_owner);
  if (!warehouses.length) return <EmptyWorkspace profile={profile}/>;
  const [initial, initialAlerts] = await Promise.all([
    loadInventory(target.data_owner, { compact: true }), settings(target.data_owner, warehouses[0].code),
  ]);
  return <InventoryDashboard initial={initial} initialAlerts={initialAlerts} accountProfile={profile}/>;
}
