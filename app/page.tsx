import { requireChatGPTUser } from "./chatgpt-auth";
import InventoryDashboard from "@/components/inventory-dashboard";
import { loadInventory } from "@/lib/inventory-store";
import { currentContext } from "@/lib/auth";
import { loadWarehouses } from "@/lib/inventory-store";
import { EmptyWorkspace } from "@/components/empty-workspace";
import { settings } from "@/lib/alerts-store";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireChatGPTUser("/");
  const {actor,target}=await currentContext();
  const profile={id:actor.id,name:actor.display_name,role:actor.role,targetId:target.id,targetName:target.display_name};
  const warehouses=await loadWarehouses(target.data_owner);
  if(!warehouses.length)return <EmptyWorkspace profile={profile}/>;
  const [initial, initialAlerts] = await Promise.all([loadInventory(target.data_owner,{compact:true}), settings(target.data_owner,warehouses[0].code)]);
  return <InventoryDashboard initial={initial} initialAlerts={initialAlerts} accountProfile={profile}/>;
}
