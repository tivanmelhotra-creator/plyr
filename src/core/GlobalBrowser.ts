import { chromium } from 'playwright-extra';
import type { Browser, BrowserContext } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { config } from '../config';
import {
  ANTI_AUTOMATION_ARGS,
  interactiveContextOptions,
  saveStorageState,
  withUtf8Locale,
} from './BrowserProfile';
import { RealChrome } from './RealChrome';

// Apply stealth plugin
chromium.use(stealth());

/**
 * GlobalBrowser - Shared browser instance for Free users
 * 
 * This is a singleton that manages a single browser process
 * shared among all free-tier users. Each user gets their own
 * isolated BrowserContext (cookies, storage, etc.)
 */
export class GlobalBrowser {
  private static instance: Browser | null = null;
  private static isShuttingDown = false;
  private static restartAttempts = 0;
  private static readonly maxRestartAttempts = 5;
  
  // ✅ NEW: Exponential backoff for restarts
  private static restartBackoffMs = 2000;
  private static readonly maxBackoffMs = 60000;
  
  // ✅ NEW: Track last healthy state
  private static lastHealthyTime = 0;
  private static consecutiveFailures = 0;

  /**
   * Initialize the Global Browser (Singleton)
   */
  static async initialize(): Promise<void> {
    if (this.instance && this.instance.isConnected()) {
      this.lastHealthyTime = Date.now();
      return;
    }
    
    if (this.isShuttingDown) {
      console.log('[GlobalBrowser] Shutdown in progress, skipping initialization');
      return;
    }

    try {
      console.log('[GlobalBrowser] Launching shared browser instance...');
      
      this.instance = await chromium.launch({
        headless: config.DEFAULT_HEADLESS,
        timeout: config.BROWSER_LAUNCH_TIMEOUT_MS,
        // Use a system Chrome only if CHROME_EXE is set; otherwise Playwright bundled Chromium.
        ...(config.CHROME_EXE ? { executablePath: config.CHROME_EXE } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--no-first-run',
          '--disable-translate',
          '--disable-features=TranslateUI',
          '--js-flags=--max-old-space-size=512',
          // ✅ NEW: Additional stability flags
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-ipc-flooding-protection',
          // Without these Chromium advertises navigator.webdriver and
          // automation client hints, which is the single loudest bot signal
          // there is. The stealth plugin patches the JS getter afterwards;
          // the flag stops the signal being emitted at all (headers included).
          ...ANTI_AUTOMATION_ARGS,
        ],
        // --enable-automation is one of Playwright's OWN defaults, so it can
        // only be dropped here; passing a counter-argument does not remove it
        // (measured — see IGNORED_DEFAULT_ARGS). Leaving it in would keep
        // emitting the automation signal the args above exist to suppress.
        // --disable-extensions stays: this headless pool wants no extensions.
        ignoreDefaultArgs: ['--enable-automation'],
        // A UTF-8 locale, or Chromium cannot represent a non-ASCII download
        // name in a POSIX path and replaces the whole thing — extension
        // included — with the literal string `download`. See withUtf8Locale.
        env: withUtf8Locale(process.env),
      });

      // Reset counters on successful launch
      this.restartAttempts = 0;
      this.restartBackoffMs = 2000;
      this.consecutiveFailures = 0;
      this.lastHealthyTime = Date.now();

      // Auto-restart on crash with exponential backoff
      this.instance.on('disconnected', () => {
        if (this.isShuttingDown) return;
        
        console.warn('[GlobalBrowser] ⚠️ Browser crashed or disconnected!');
        this.instance = null;
        this.consecutiveFailures++;
        
        if (this.restartAttempts < this.maxRestartAttempts) {
          this.restartAttempts++;
          
          // ✅ Exponential backoff
          const delay = Math.min(this.restartBackoffMs, this.maxBackoffMs);
          this.restartBackoffMs *= 2;
          
          console.log(
            `[GlobalBrowser] Restarting in ${delay}ms... ` +
            `(attempt ${this.restartAttempts}/${this.maxRestartAttempts})`
          );
          
          setTimeout(() => this.initialize(), delay);
        } else {
          console.error(
            '[GlobalBrowser] ❌ Max restart attempts reached. ' +
            'Manual intervention required. Call GlobalBrowser.forceRestart()'
          );
        }
      });

      console.log('[GlobalBrowser] ✓ Shared browser ready.');
      
    } catch (e) {
      console.error('[GlobalBrowser] Failed to launch:', e);
      this.consecutiveFailures++;
      
      // Retry after delay with backoff
      if (this.restartAttempts < this.maxRestartAttempts) {
        this.restartAttempts++;
        const delay = Math.min(this.restartBackoffMs, this.maxBackoffMs);
        this.restartBackoffMs *= 2;
        
        console.log(`[GlobalBrowser] Retrying in ${delay}ms...`);
        setTimeout(() => this.initialize(), delay);
      }
    }
  }

  /**
   * Get a new lightweight context from the shared browser
   */
  static async getContext(): Promise<BrowserContext> {
    // ✅ Enhanced health check with retry
    if (!this.instance || !this.instance.isConnected()) {
      console.log('[GlobalBrowser] Browser not available, initializing...');
      await this.initialize();
      
      // Wait a bit for initialization
      if (!this.instance) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    if (!this.instance || !this.instance.isConnected()) {
      throw new Error(
        'GlobalBrowser is not available. ' +
        `Consecutive failures: ${this.consecutiveFailures}. ` +
        'Please retry in a few seconds.'
      );
    }

    // Update healthy time
    this.lastHealthyTime = Date.now();
    this.consecutiveFailures = 0;

    // Create new context with random fingerprint
    const context = await this.instance.newContext({
      viewport: this.getRandomViewport(),
      userAgent: this.getRandomUserAgent(),
      locale: 'en-US',
      // ✅ NEW: Additional context options for stability
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      bypassCSP: false,
    });

    return context;
  }

  /**
   * Get a context for an INTERACTIVE session (Element Picker / Live Browser).
   *
   * Different contract from getContext() on purpose:
   *   getContext()            → throwaway + random fingerprint  (workflow runs)
   *   getInteractiveContext() → persistent + stable fingerprint (a human)
   *
   * A person picking a selector needs the SAME browser identity each time and
   * needs their cookies back, otherwise every visit to a logged-in page is a
   * login wall (HANDOFF 15 AUTH-GAP). Randomising the fingerprint per open,
   * which is right for a run, is actively harmful here: it makes a site treat
   * every session as a brand-new stranger and challenge it.
   */
  static async getInteractiveContext(
    userId: string,
    viewport?: { width: number; height: number },
  ): Promise<BrowserContext> {
    // REAL CHROME MODE
    // ----------------
    // A throwaway context can never load an extension, so when the operator has
    // asked for real extensions we hand back the shared PERSISTENT Chrome
    // instead. Same profile as the remote desktop, which is the entire point:
    // cookies a user imports through their cookie extension are immediately the
    // cookies this picker — and every automation run — sees.
    if (RealChrome.isEnabled()) {
      return RealChrome.getContext();
    }

    if (!this.instance || !this.instance.isConnected()) {
      await this.initialize();
    }
    if (!this.instance || !this.instance.isConnected()) {
      throw new Error('GlobalBrowser is not available. Please retry in a few seconds.');
    }
    this.lastHealthyTime = Date.now();
    this.consecutiveFailures = 0;
    const options = await interactiveContextOptions(userId, this.instance, { viewport });
    return this.instance.newContext(options);
  }

  /**
   * Persist an interactive context's cookies/localStorage for this user, then
   * close it. Saving BEFORE closing is the whole point: the login the user did
   * inside the picker modal is only durable if it is written out here.
   */
  static async saveAndCloseContext(context: BrowserContext, userId: string): Promise<boolean> {
    let saved = false;
    try { saved = await saveStorageState(context, userId); } catch { saved = false; }
    // The shared real-Chrome context outlives every session that borrows it.
    // Closing it here would shut the browser the user is watching in the remote
    // desktop, and evict every other live session with it. Its state is already
    // durable in the on-disk profile, so there is nothing to close for.
    if (RealChrome.isSharedContext(context)) return saved;
    await this.closeContext(context);
    return saved;
  }

  /**
   * Check if browser is healthy
   */
  static isHealthy(): boolean {
    if (!this.instance) return false;
    
    try {
      return this.instance.isConnected();
    } catch {
      return false;
    }
  }

  /**
   * ✅ NEW: Get detailed health status
   */
  static getHealthStatus(): {
    healthy: boolean;
    connected: boolean;
    contextCount: number;
    lastHealthyAgo: number;
    consecutiveFailures: number;
    restartAttempts: number;
  } {
    const now = Date.now();
    return {
      healthy: this.isHealthy(),
      connected: this.instance?.isConnected() ?? false,
      contextCount: this.getContextCount(),
      lastHealthyAgo: this.lastHealthyTime > 0 ? now - this.lastHealthyTime : -1,
      consecutiveFailures: this.consecutiveFailures,
      restartAttempts: this.restartAttempts
    };
  }

  /**
   * Get active contexts count
   */
  static getContextCount(): number {
    if (!this.instance) return 0;
    try {
      return this.instance.contexts().length;
    } catch {
      return 0;
    }
  }

  /**
   * ✅ NEW: Force restart (for admin use)
   */
  static async forceRestart(): Promise<boolean> {
    console.log('[GlobalBrowser] Force restart requested...');
    
    // Close existing browser if any
    if (this.instance) {
      try {
        for (const context of this.instance.contexts()) {
          await context.close().catch(() => {});
        }
        await this.instance.close().catch(() => {});
      } catch (e) {
        console.error('[GlobalBrowser] Error during force close:', e);
      }
      this.instance = null;
    }
    
    // Reset counters
    this.restartAttempts = 0;
    this.restartBackoffMs = 2000;
    this.consecutiveFailures = 0;
    this.isShuttingDown = false;
    
    // Reinitialize
    await this.initialize();
    
    return this.isHealthy();
  }

  /**
   * ✅ NEW: Close a specific context safely
   */
  static async closeContext(context: BrowserContext): Promise<void> {
    // Guard the shared persistent context here too: closeContext is called from
    // several places (GC, error paths) that have no idea the context is shared.
    if (RealChrome.isSharedContext(context)) return;
    try {
      // Close all pages first
      for (const page of context.pages()) {
        await page.close().catch(() => {});
      }
      // Then close context
      await context.close();
    } catch (e) {
      // Context might already be closed
    }
  }

  /**
   * Shutdown the global browser
   */
  static async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    if (this.instance) {
      try {
        // Close all contexts first
        const contexts = this.instance.contexts();
        console.log(`[GlobalBrowser] Closing ${contexts.length} context(s)...`);
        
        for (const context of contexts) {
          await context.close().catch(() => {});
        }
        
        await this.instance.close();
        console.log('[GlobalBrowser] ✓ Closed successfully');
      } catch (e) {
        console.error('[GlobalBrowser] Error during shutdown:', e);
      }
      this.instance = null;
    }
  }

  /**
   * Get random viewport for fingerprint diversity
   */
  private static getRandomViewport(): { width: number; height: number } {
    const viewports = [
      { width: 1280, height: 720 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
      { width: 1536, height: 864 },
      { width: 1600, height: 900 },
      { width: 1920, height: 1080 },
    ];
    
    const base = viewports[Math.floor(Math.random() * viewports.length)];
    
    // Add small random variation
    return {
      width: base.width + Math.floor(Math.random() * 20) - 10,
      height: base.height + Math.floor(Math.random() * 20) - 10
    };
  }

  /**
   * Get random user agent for fingerprint diversity
   */
  private static getRandomUserAgent(): string {
    const userAgents = [
      // Chrome Windows
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      // Chrome Mac
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      // Chrome Linux
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      // Edge
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
}