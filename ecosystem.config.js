module.exports = {
  apps: [{
    name: "Hybrid-Automation",
    script: "./dist/index.js",

    // ⚠️ 4 CLUSTER INSTANCES AND THE REMOTE BROWSER DO NOT MIX.
    //
    // Left as-is because changing it would alter the throughput characteristics
    // of an existing deployment, but the conflict must be written down:
    // `RealChrome` uses ONE persistent profile directory
    // (REAL_CHROME_USER_DATA_DIR) and Chrome enforces single-ownership of it
    // with a SingletonLock. Four workers all trying to launch means one wins
    // and the rest fail with "ProcessSingleton / already running" — which
    // RealChrome does report clearly, but it is still four-way roulette over
    // which worker owns the browser, and /browser/* requests land on whichever
    // worker the load balancer picked.
    //
    // If this instance serves the Remote Browser, run it with instances: 1
    // (exec_mode: "fork"). Use the cluster only for queue/API-only deployments,
    // where APP_ENV=production (headless) is also the right profile.
    instances: 4,
    exec_mode: "cluster",
    
    // ✅ اضافه شده: نمایش زمان در لاگ‌های PM2
    time: true,
    
    // ✅ اضافه شده: تفکیک فایل‌های لاگ سیستمی
    error_file: "./logs/pm2-error.log",
    out_file: "./logs/pm2-out.log",
    
    // ادغام لاگ‌های کلاسترهای مختلف در یک فایل
    merge_logs: true,

    env: {
      NODE_ENV: "production",
      // Headed browser on a virtual display, so extensions and the Element
      // Inspector load. `production` alone is headless and loads none of them.
      APP_ENV: "server",
    },
    
    env_development: {
      NODE_ENV: "development",
      APP_ENV: "development",
      watch: true, 
      ignore_watch: ["node_modules", "logs", "profiles"],
    },

    max_memory_restart: '1G',
    autorestart: true,
  }]
}