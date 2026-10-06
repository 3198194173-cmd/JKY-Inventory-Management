import { env } from "./runtime";

export function serverConfig() {
  return {
    appkey: env.JACKYUN_APP_KEY || "92058521",
    secret: env.JACKYUN_APP_SECRET || "",
    configured: !!env.JACKYUN_APP_SECRET,
    robotConfigured: !!(env.DINGTALK_CLIENT_ID && env.DINGTALK_CLIENT_SECRET && env.DINGTALK_ROBOT_CODE),
  };
}
