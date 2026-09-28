declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    JACKYUN_APP_KEY?: string;
    JACKYUN_APP_SECRET?: string;
    JACKYUN_WAREHOUSE_CODE?: string;
    DINGTALK_CLIENT_ID?: string;
    DINGTALK_CLIENT_SECRET?: string;
    DINGTALK_ROBOT_CODE?: string;
    DINGTALK_OPEN_CONVERSATION_ID?: string;
  }
}
