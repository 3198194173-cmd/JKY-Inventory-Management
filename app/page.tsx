import { requireChatGPTUser } from "./chatgpt-auth";
import InventoryDashboard from "@/components/inventory-dashboard";
import { loadInventory } from "@/lib/inventory-store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <InventoryDashboard initial={await loadInventory(user.userId)} />;
}
