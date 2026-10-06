import { requireChatGPTUser } from "./chatgpt-auth";
import InventoryDashboard from "@/components/inventory-dashboard";
import { loadInventory } from "@/lib/inventory-store";
import { settings } from "@/lib/alerts-store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  const [initial, initialAlerts] = await Promise.all([loadInventory(user.userId), settings(user.userId)]);
  return <InventoryDashboard initial={initial} initialAlerts={initialAlerts} />;
}
