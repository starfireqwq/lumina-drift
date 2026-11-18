import { buildApp } from './app';
import { config } from './config';

async function main() {
  try {
    const app = await buildApp();

    await app.listen({
      port: config.port,
      host: config.host,
    });

    console.log(`[Lumina Drift Server] Listening on http://${config.host}:${config.port}`);
    console.log(`[Lumina Drift Server] Health check: http://localhost:${config.port}/health`);
    console.log(`[Lumina Drift Server] SQLite Database: ${config.dbPath} (WAL Mode enabled)`);
    console.log(`[Lumina Drift Server] Socket.io Realtime Gateway ready on ws://localhost:${config.port}`);

    console.log(`\n================================================================`);
    console.log(`🎨 Lumina Drift 流光私人伺服器已就緒！`);
    console.log(`🌐 本地存取網址: http://localhost:${config.port}`);
    console.log(`🔒 私域內網穿透提示 (無需設定路由器 Port Forwarding):`);
    console.log(`   1. Tailscale: 啟用後將 Tailscale 虛擬內網 IP 分享給好友 (例如 http://100.x.y.z:${config.port})`);
    console.log(`   2. Cloudflare Tunnel: 執行 'cloudflared tunnel --url http://localhost:${config.port}' 取得即時 HTTPS 網址`);
    console.log(`================================================================\n`);
  } catch (err) {
    console.error('[Lumina Drift Server] Fatal startup error:', err);
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Lumina Drift Server] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Lumina Drift Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

main();
